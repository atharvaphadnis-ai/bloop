// modules/database-adapters.js — provider-based database adapter architecture.
// Every provider implements the same interface; capabilities are reported
// honestly so the UI can label what each provider actually supports.
import { AppError, badRequest } from '../core/error-handler.js';

/**
 * Provider catalog — single source of truth for what Bloop can connect to.
 * requiresDriver: optional npm package loaded dynamically when a connection
 * is opened. Missing drivers produce a clear, actionable error.
 */
export const PROVIDER_CATALOG = [
  {
    id: 'sqlite', name: 'SQLite (embedded)', type: 'sql', embedded: true,
    requiresDriver: null, default: true,
    capabilities: { sql: true, nosql: false, transactions: true, explain: true, branching: 'file-clone', cdc: 'platform-write-layer', backup: 'consistent-snapshot' },
    notes: 'Embedded and enabled by default. Stores data in a single file under storage/projects/<id>/db/.',
  },
  {
    id: 'postgres', name: 'PostgreSQL', type: 'sql',
    requiresDriver: 'pg', installHint: 'npm install pg',
    capabilities: { sql: true, nosql: false, transactions: true, explain: true, branching: 'database-clone', cdc: 'listen-notify', backup: 'sql-dump' },
    notes: 'Requires the optional "pg" driver package and a reachable PostgreSQL server.',
  },
  {
    id: 'mysql', name: 'MySQL', type: 'sql',
    requiresDriver: 'mysql2', installHint: 'npm install mysql2',
    capabilities: { sql: true, nosql: false, transactions: true, explain: true, branching: 'dump-clone', cdc: 'none', backup: 'sql-dump' },
    notes: 'Requires the optional "mysql2" driver package. Binlog-based CDC is not provided.',
  },
  {
    id: 'mariadb', name: 'MariaDB', type: 'sql',
    requiresDriver: 'mysql2', installHint: 'npm install mysql2',
    capabilities: { sql: true, nosql: false, transactions: true, explain: true, branching: 'dump-clone', cdc: 'none', backup: 'sql-dump' },
    notes: 'Uses the "mysql2" driver (protocol-compatible). Binlog-based CDC is not provided.',
  },
  {
    id: 'mongodb', name: 'MongoDB', type: 'nosql',
    requiresDriver: 'mongodb', installHint: 'npm install mongodb',
    capabilities: { sql: false, nosql: true, aggregation: true, changeStreams: true, transactions: 'replica-set-only', branching: 'namespace-clone', cdc: 'change-streams' },
    notes: 'Requires the optional "mongodb" driver package. Change streams need a replica set.',
  },
  {
    id: 'badger', name: 'BadgerDB (sidecar)', type: 'kv',
    requiresDriver: null,
    capabilities: { sql: false, nosql: false, kv: true, transactions: false, branching: 'none', cdc: 'none' },
    notes: 'BadgerDB is a Go library. Bloop talks to it through the optional HTTP sidecar in docker/badger-sidecar (an isolated compatibility bridge, exactly as documented).',
  },
];

export function providerMeta(providerId) {
  return PROVIDER_CATALOG.find((p) => p.id === providerId) || null;
}

export function validateProviderConfig(provider, config) {
  const meta = providerMeta(provider);
  if (!meta) {
    throw badRequest(`Unknown provider "${provider}". Supported: ${PROVIDER_CATALOG.map((p) => p.id).join(', ')}`);
  }
  const required = {
    sqlite: [],
    postgres: ['host', 'database', 'user'],
    mysql: ['host', 'database', 'user'],
    mariadb: ['host', 'database', 'user'],
    mongodb: ['url'],
    badger: ['endpoint'],
  }[provider] || [];
  const missing = required.filter((k) => !config?.[k]);
  if (missing.length) {
    throw badRequest(`Provider "${provider}" requires config fields: ${missing.join(', ')}`);
  }
  return true;
}

const registry = new Map();

export function registerAdapter(providerId, adapterClass) {
  registry.set(providerId, adapterClass);
}

export function getAdapterClass(providerId) {
  const cls = registry.get(providerId);
  if (!cls) {
    throw new AppError(501, 'PROVIDER_NOT_AVAILABLE',
      `Provider "${providerId}" is registered in the catalog but its adapter is not loaded in this build.`);
  }
  return cls;
}

export function listRegisteredAdapters() {
  return [...registry.keys()];
}

export async function register(ctx) {
  ctx.log.debug?.(`adapter registry ready (${registry.size} adapters self-register on import)`);
}

/**
 * Attempt to dynamically import an optional driver package.
 * Returns the module or null (never throws) — callers decide how to report.
 */
export async function detectDriver(packageName) {
  try {
    return await import(/* @vite-ignore */ packageName);
  } catch {
    return null;
  }
}

export async function driverStatus() {
  const out = {};
  for (const p of PROVIDER_CATALOG) {
    if (!p.requiresDriver) { out[p.id] = { ok: true, driver: null }; continue; }
    const mod = await detectDriver(p.requiresDriver);
    out[p.id] = { ok: !!mod, driver: p.requiresDriver, installHint: p.installHint };
  }
  return out;
}

/**
 * Base class all adapters extend. Subclasses override the async methods they
 * can genuinely support; unsupported operations throw a descriptive error.
 */
export class BaseAdapter {
  constructor(providerId, connectionId, config) {
    this.provider = providerId;
    this.connectionId = connectionId;
    this.config = config || {};
    this.connected = false;
  }

  capabilities() {
    return providerMeta(this.provider)?.capabilities || {};
  }

  _unsupported(what) {
    throw new AppError(501, 'CAPABILITY_UNSUPPORTED',
      `${what} is not supported by the ${this.provider} provider (capabilities: ${JSON.stringify(this.capabilities())})`);
  }

  async connect() { throw this._unsupported('connect'); }
  async disconnect() { this.connected = false; }
  async health() { return { status: this.connected ? 'ok' : 'down', provider: this.provider }; }
  async query() { this._unsupported('query'); }
  async exec() { this._unsupported('exec'); }
  async listTables() { this._unsupported('schema inspection'); }
  async listColumns() { this._unsupported('column inspection'); }
  async listIndexes() { this._unsupported('index inspection'); }
  async listForeignKeys() { return []; }
  async createTable() { this._unsupported('table creation'); }
  async dropTable() { this._unsupported('table deletion'); }
  async renameTable() { this._unsupported('table rename'); }
  async addColumn() { this._unsupported('column addition'); }
  async dropColumn() { this._unsupported('column deletion'); }
  async createIndex() { this._unsupported('index creation'); }
  async dropIndex() { this._unsupported('index deletion'); }
  async transaction() { this._unsupported('transactions'); }
  async explain() { this._unsupported('query plans'); }
  async dump() { this._unsupported('export'); }
  async executeFile(sql) { return this.exec(sql); }
  async tableSize() { return null; }
}
