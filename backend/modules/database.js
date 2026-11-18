// modules/database.js — DatabaseManager: opens the system metadata store,
// defines the platform schema, manages database connections per project
// (create/test/health/switch), caches adapters, logs activity and coordinates
// import/export. This is the facade every database feature goes through.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import crypto from 'node:crypto';
import { getAdapterClass, providerMeta, validateProviderConfig, PROVIDER_CATALOG, driverStatus, listRegisteredAdapters } from './database-adapters.js';
import { badRequest, notFound, AppError } from '../core/error-handler.js';
import { validateOrThrow } from '../core/validation.js';

const SECRET_FIELDS = new Set(['password', 'secret', 'apiKey', 'token', 'urlCredentials']);

export class DatabaseManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'database' });
    this.adapters = new Map();   // connectionId -> adapter instance
    this.monitor = null;
    this.activitySweep = null;
  }

  // ── System metadata store ─────────────────────────────────────────────────
  openSystemStore() {
    const file = path.isAbsolute(this.ctx.config.get('database.sqliteFile'))
      ? this.ctx.config.get('database.sqliteFile')
      : path.join(this.ctx.env.dataDir, 'system', 'bloop-system.db');
    this.ctx.log.debug(`system store: ${file}`);
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    const prepared = new Map();
    const prep = (sql) => {
      let stmt = prepared.get(sql);
      if (!stmt) { stmt = db.prepare(sql); prepared.set(sql, stmt); }
      return stmt;
    };
    const system = {
      db,
      file,
      all: (sql, params = []) => prep(sql).all(...params.map((p) => (p === undefined ? null : p))),
      get: (sql, params = []) => prep(sql).get(...params.map((p) => (p === undefined ? null : p))),
      run: (sql, params = []) => prep(sql).run(...params.map((p) => (p === undefined ? null : p))),
      exec: (sql) => db.exec(sql),
      tx: (fn) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const r = fn();
          db.exec('COMMIT');
          return r;
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch { /* no tx active */ }
          throw err;
        }
      },
    };
    this.ctx.system = system;
    return system;
  }

  ensureSystemSchema() {
    const sys = this.ctx.system;
    sys.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS admin_users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, password_hash TEXT NOT NULL, role TEXT DEFAULT 'developer', totp_secret TEXT, totp_enabled INTEGER DEFAULT 0, disabled INTEGER DEFAULT 0, created_at TEXT, last_login_at TEXT);
      CREATE TABLE IF NOT EXISTS admin_sessions (id TEXT PRIMARY KEY, user_id TEXT, refresh_hash TEXT UNIQUE, user_agent TEXT, ip TEXT, created_at TEXT, expires_at TEXT, revoked INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT, slug TEXT UNIQUE, created_at TEXT);
      CREATE TABLE IF NOT EXISTS org_members (org_id TEXT, user_id TEXT, role TEXT, created_at TEXT, PRIMARY KEY (org_id, user_id));
      CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, org_id TEXT, email TEXT, role TEXT, token_hash TEXT, status TEXT, invited_by TEXT, created_at TEXT, expires_at TEXT);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, org_id TEXT, name TEXT, slug TEXT, description TEXT DEFAULT '', region TEXT DEFAULT 'local', status TEXT DEFAULT 'active', created_at TEXT, updated_at TEXT, created_by TEXT);
      CREATE TABLE IF NOT EXISTS project_environments (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, is_default INTEGER DEFAULT 0, cloned_from TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS env_vars (id TEXT PRIMARY KEY, project_id TEXT, env_id TEXT, key TEXT, value_encrypted TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, key_hash TEXT, key_prefix TEXT, key_type TEXT, scopes_json TEXT, revoked INTEGER DEFAULT 0, created_at TEXT, last_used_at TEXT);
      CREATE TABLE IF NOT EXISTS db_connections (id TEXT PRIMARY KEY, project_id TEXT, env_id TEXT, name TEXT, provider TEXT, config_json TEXT, is_default INTEGER DEFAULT 0, status TEXT DEFAULT 'unknown', last_check_at TEXT, last_error TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS settings (scope TEXT, key TEXT, value_json TEXT, updated_at TEXT, PRIMARY KEY (scope, key));
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, project_id TEXT, email TEXT, phone TEXT, password_hash TEXT, email_verified INTEGER DEFAULT 0, metadata_json TEXT DEFAULT '{}', claims_json TEXT DEFAULT '{}', totp_secret TEXT, totp_enabled INTEGER DEFAULT 0, disabled INTEGER DEFAULT 0, deleted_at TEXT, created_at TEXT, updated_at TEXT, last_login_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_project_email ON users(project_id, email);
      CREATE TABLE IF NOT EXISTS user_identities (id TEXT PRIMARY KEY, user_id TEXT, project_id TEXT, provider TEXT, provider_user_id TEXT, metadata_json TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS user_passkeys (id TEXT PRIMARY KEY, project_id TEXT, user_id TEXT, credential_id TEXT UNIQUE, public_key_cose BLOB, sign_count INTEGER DEFAULT 0, transports TEXT, created_at TEXT, last_used_at TEXT);
      CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, project_id TEXT, user_id TEXT, type TEXT, token_hash TEXT, expires_at TEXT, used_at TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT, user_id TEXT, refresh_hash TEXT UNIQUE, ip TEXT, user_agent TEXT, created_at TEXT, expires_at TEXT, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS buckets (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, public INTEGER DEFAULT 0, max_file_size INTEGER DEFAULT 52428800, allowed_mimes TEXT DEFAULT '', provider TEXT DEFAULT 'local', created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS objects (id TEXT PRIMARY KEY, project_id TEXT, bucket_id TEXT, path TEXT, storage_key TEXT, mime TEXT, size INTEGER DEFAULT 0, etag TEXT, version INTEGER DEFAULT 1, metadata_json TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT, deleted INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS object_versions (id TEXT PRIMARY KEY, object_id TEXT, project_id TEXT, version INTEGER, storage_key TEXT, size INTEGER, created_at TEXT);
      CREATE TABLE IF NOT EXISTS functions (id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, name TEXT, code TEXT, enabled INTEGER DEFAULT 1, timeout_ms INTEGER DEFAULT 10000, secrets_json TEXT DEFAULT '[]', triggers_json TEXT DEFAULT '[]', created_at TEXT, updated_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_functions_slug ON functions(project_id, slug);
      CREATE TABLE IF NOT EXISTS function_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, function_id TEXT, invocation_id TEXT, level TEXT, message TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS function_executions (id TEXT PRIMARY KEY, project_id TEXT, function_id TEXT, trigger TEXT, status TEXT, duration_ms INTEGER, error TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, url TEXT, secret TEXT, events_json TEXT DEFAULT '[]', headers_json TEXT DEFAULT '{}', enabled INTEGER DEFAULT 1, timeout_ms INTEGER DEFAULT 10000, max_retries INTEGER DEFAULT 5, created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS webhook_deliveries (id TEXT PRIMARY KEY, webhook_id TEXT, project_id TEXT, event TEXT, payload_json TEXT, status TEXT, status_code INTEGER, attempt INTEGER DEFAULT 1, response_body TEXT, error TEXT, created_at TEXT, delivered_at TEXT, next_retry_at TEXT);
      CREATE TABLE IF NOT EXISTS scheduled_jobs (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, type TEXT, cron_expr TEXT, target_type TEXT, target_ref TEXT, payload_json TEXT, enabled INTEGER DEFAULT 1, max_attempts INTEGER DEFAULT 3, last_run_at TEXT, next_run_at TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS job_runs (id TEXT PRIMARY KEY, job_id TEXT, status TEXT, started_at TEXT, finished_at TEXT, duration_ms INTEGER, error TEXT, result_json TEXT);
      CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, project_id TEXT, connection_id TEXT, name TEXT, filename TEXT, checksum TEXT, applied_at TEXT, rolled_back_at TEXT, execution_ms INTEGER, status TEXT);
      CREATE TABLE IF NOT EXISTS query_history (id TEXT PRIMARY KEY, project_id TEXT, connection_id TEXT, sql TEXT, status TEXT, duration_ms INTEGER, row_count INTEGER, error TEXT, created_at TEXT, created_by TEXT);
      CREATE TABLE IF NOT EXISTS saved_queries (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, sql TEXT, connection_id TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS db_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, connection_id TEXT, operation TEXT, detail_json TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS collection_meta (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, indexes_json TEXT DEFAULT '[]', options_json TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, project_id TEXT, collection_id TEXT, data_json TEXT, version INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT, deleted INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS document_history (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT, project_id TEXT, version INTEGER, data_json TEXT, changed_at TEXT);
      CREATE TABLE IF NOT EXISTS row_policies (id TEXT PRIMARY KEY, project_id TEXT, table_name TEXT, policy_name TEXT, command TEXT, expression TEXT, roles TEXT, enabled INTEGER DEFAULT 1, created_at TEXT);
      CREATE TABLE IF NOT EXISTS custom_endpoints (id TEXT PRIMARY KEY, project_id TEXT, path TEXT, method TEXT, function_id TEXT, auth_required INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1, created_at TEXT);
      CREATE TABLE IF NOT EXISTS oauth_configs (id TEXT PRIMARY KEY, project_id TEXT, provider TEXT, client_id TEXT, client_secret_encrypted TEXT, redirect_url TEXT, scopes TEXT, enabled INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS smtp_settings (id TEXT PRIMARY KEY, project_id TEXT, host TEXT, port INTEGER, secure INTEGER DEFAULT 0, username TEXT, password_encrypted TEXT, from_email TEXT, from_name TEXT, enabled INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS email_templates (id TEXT PRIMARY KEY, project_id TEXT, template TEXT, subject TEXT, html TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS email_log (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, \"to\" TEXT, subject TEXT, template TEXT, status TEXT, error TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS cdc_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, project_id TEXT, provider TEXT, connection_id TEXT, table_name TEXT, op TEXT, pk TEXT, before_json TEXT, after_json TEXT, created_at TEXT, processed INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cdc_checkpoints (id TEXT PRIMARY KEY, project_id TEXT, provider TEXT, connection_id TEXT, checkpoint TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, type TEXT, status TEXT, size INTEGER, checksum TEXT, encrypted INTEGER DEFAULT 0, destination TEXT, path TEXT, entries INTEGER, created_at TEXT, verified_at TEXT, error TEXT, restore_tested_at TEXT);
      CREATE TABLE IF NOT EXISTS restore_jobs (id TEXT PRIMARY KEY, backup_id TEXT, project_id TEXT, status TEXT, mode TEXT, steps_json TEXT, started_at TEXT, finished_at TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT, project_id TEXT, actor TEXT, actor_type TEXT DEFAULT 'admin', action TEXT, target TEXT, metadata_json TEXT, ip TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, level TEXT, source TEXT, message TEXT, meta_json TEXT, project_id TEXT, request_id TEXT);
      CREATE TABLE IF NOT EXISTS request_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, project_id TEXT, method TEXT, path TEXT, status INTEGER, duration_ms REAL, ip TEXT, user_agent TEXT, request_id TEXT);
      CREATE TABLE IF NOT EXISTS auth_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, project_id TEXT, event TEXT, user_id TEXT, email TEXT, ip TEXT, user_agent TEXT, success INTEGER, detail_json TEXT);
      CREATE TABLE IF NOT EXISTS realtime_channels (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, private INTEGER DEFAULT 0, created_at TEXT);
      CREATE TABLE IF NOT EXISTS plugins_installed (id TEXT PRIMARY KEY, name TEXT UNIQUE, version TEXT, path TEXT, enabled INTEGER DEFAULT 0, manifest_json TEXT, config_json TEXT DEFAULT '{}', installed_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS import_jobs (id TEXT PRIMARY KEY, project_id TEXT, source TEXT, status TEXT, config_json TEXT, progress_json TEXT DEFAULT '{}', summary_json TEXT, error TEXT, created_at TEXT, finished_at TEXT);
    `);
    const versionRow = sys.get('SELECT value FROM meta WHERE key = ?', ['schema_version']);
    if (!versionRow) {
      sys.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['schema_version', '1']);
    }
    // settings defaults
    const now = new Date().toISOString();
    const defaults = [
      ['platform', 'name', 'Bloop'],
      ['platform', 'tagline', 'Your backend. Your rules. Your database.'],
      ['realtime', 'enabled', true],
      ['security', 'requireEmailVerification', false],
    ];
    for (const [scope, key, value] of defaults) {
      sys.run('INSERT OR IGNORE INTO settings (scope, key, value_json, updated_at) VALUES (?,?,?,?)',
        [scope, key, JSON.stringify(value), now]);
    }
  }

  // ── Connections ───────────────────────────────────────────────────────────
  async createConnection(projectId, input) {
    const data = validateOrThrow({
      name: { type: 'string', required: true, min: 1, max: 64 },
      provider: { type: 'string', required: true, enum: PROVIDER_CATALOG.map((p) => p.id) },
      config: { type: 'object', required: true },
      envId: { type: 'string' },
      isDefault: { type: 'boolean', default: false },
    }, input);
    validateProviderConfig(data.provider, data.config);
    // sqlite provider is a first-class data-plane provider that can be disabled
    if (data.provider === 'sqlite' && !this.ctx.config.get('database.sqliteEnabled', true)) {
      throw badRequest('Embedded SQLite is disabled in platform settings — choose an external provider.');
    }
    if (data.provider === 'sqlite') {
      if (!data.config.filename && !data.config.embedded) throw badRequest('sqlite connections need a filename');
      if (!data.config.filename) {
        data.config.filename = path.join(this.ctx.projects.projectDir(projectId), 'db', `${data.name || 'main'}.db`);
        data.config.embedded = true;
      }
    }
    const testResult = await this.testConnection(data.provider, data.config);
    if (testResult.status !== 'ok') {
      throw badRequest(`Connection test failed: ${testResult.error || 'unreachable'}`);
    }
    const id = crypto.randomUUID();
    const safeConfig = this._encryptConfig(data.config);
    this.ctx.system.run(
      'INSERT INTO db_connections (id, project_id, env_id, name, provider, config_json, is_default, status, last_check_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, projectId, data.envId || null, data.name, data.provider, JSON.stringify(safeConfig), data.isDefault ? 1 : 0, 'ok', new Date().toISOString(), new Date().toISOString()]
    );
    if (data.isDefault) this.setDefaultConnection(projectId, id);
    this.ctx.audit?.record({ actor: 'system', action: 'db.connection.create', target: id, projectId, meta: { name: data.name, provider: data.provider } });
    this.log.info(`connection "${data.name}" (${data.provider}) created for project ${projectId}`);
    return this.getConnection(id);
  }

  _encryptConfig(config) {
    const out = { ...config };
    for (const k of Object.keys(out)) {
      if (SECRET_FIELDS.has(k) && typeof out[k] === 'string' && !out[k].startsWith('enc:v1:')) {
        out[k] = this.ctx.security.encrypt(out[k]);
      }
    }
    return out;
  }

  _decryptConfig(configJson) {
    const config = typeof configJson === 'string' ? JSON.parse(configJson || '{}') : { ...(configJson || {}) };
    for (const k of Object.keys(config)) {
      if (SECRET_FIELDS.has(k) && typeof config[k] === 'string' && config[k].startsWith('enc:v1:')) {
        try { config[k] = this.ctx.security.decrypt(config[k]); } catch { config[k] = ''; }
      }
    }
    return config;
  }

  maskConfig(configJson) {
    const cfg = typeof configJson === 'string' ? JSON.parse(configJson || '{}') : (configJson || {});
    const masked = { ...cfg };
    for (const k of Object.keys(masked)) {
      if (SECRET_FIELDS.has(k)) masked[k] = '••••••••';
      if (k === 'url' && typeof masked[k] === 'string') masked[k] = masked[k].replace(/\/\/[^:]+:[^@]+@/, '//***:***@');
    }
    return masked;
  }

  listConnections(projectId) {
    const rows = this.ctx.system.all('SELECT * FROM db_connections WHERE project_id = ? ORDER BY created_at', [projectId]);
    return rows.map((r) => ({
      id: r.id, project_id: r.project_id, env_id: r.env_id, name: r.name, provider: r.provider,
      is_default: !!r.is_default, status: r.status, last_check_at: r.last_check_at, last_error: r.last_error,
      created_at: r.created_at, config: this.maskConfig(r.config_json),
      capabilities: providerMeta(r.provider)?.capabilities || {},
    }));
  }

  getConnection(id) {
    const r = this.ctx.system.get('SELECT * FROM db_connections WHERE id = ?', [id]);
    if (!r) throw notFound('Database connection not found');
    return {
      ...r,
      is_default: !!r.is_default,
      config: this.maskConfig(r.config_json),
      capabilities: providerMeta(r.provider)?.capabilities || {},
    };
  }

  async updateConnection(id, patch) {
    const row = this.ctx.system.get('SELECT * FROM db_connections WHERE id = ?', [id]);
    if (!row) throw notFound('Database connection not found');
    const merged = { ...this._decryptConfig(row.config_json), ...(patch.config || {}) };
    if (patch.config) {
      const test = await this.testConnection(row.provider, merged);
      if (test.status !== 'ok') throw badRequest(`Connection test failed: ${test.error}`);
    }
    const name = patch.name || row.name;
    const envId = patch.envId !== undefined ? patch.envId : row.env_id;
    this.ctx.system.run('UPDATE db_connections SET name = ?, env_id = ?, config_json = ?, updated_at = ? WHERE id = ?',
      [name, envId, JSON.stringify(this._encryptConfig(merged)), new Date().toISOString(), id]);
    await this.closeAdapter(id); // force reconnect with new config
    await this.refreshStatus(id);
    return this.getConnection(id);
  }

  async deleteConnection(id) {
    const row = this.ctx.system.get('SELECT * FROM db_connections WHERE id = ?', [id]);
    if (!row) throw notFound('Database connection not found');
    await this.closeAdapter(id);
    this.ctx.pools?.destroyPool?.(row.project_id, id);
    this.ctx.system.run('DELETE FROM db_connections WHERE id = ?', [id]);
    this.ctx.audit?.record({ actor: 'system', action: 'db.connection.delete', target: id, projectId: row.project_id, meta: { name: row.name } });
    return { deleted: true };
  }

  async setDefaultConnection(projectId, connectionId) {
    const row = this.ctx.system.get('SELECT * FROM db_connections WHERE id = ? AND project_id = ?', [connectionId, projectId]);
    if (!row) throw notFound('Connection not found for this project');
    this.ctx.system.run('UPDATE db_connections SET is_default = 0 WHERE project_id = ?', [projectId]);
    this.ctx.system.run('UPDATE db_connections SET is_default = 1 WHERE id = ?', [connectionId]);
    return { ok: true };
  }

  getDefaultConnection(projectId) {
    return this.ctx.system.get('SELECT * FROM db_connections WHERE project_id = ? AND is_default = 1', [projectId])
      || this.ctx.system.get('SELECT * FROM db_connections WHERE project_id = ? ORDER BY created_at LIMIT 1', [projectId]);
  }

  // ── Adapter lifecycle ─────────────────────────────────────────────────────
  async getAdapter(connectionId, { fresh = false } = {}) {
    let adapter = this.adapters.get(connectionId);
    if (adapter && !fresh) return adapter;
    if (adapter) await this.closeAdapter(connectionId);
    const row = this.ctx.system.get('SELECT * FROM db_connections WHERE id = ?', [connectionId]);
    if (!row) throw notFound('Database connection not found');
    const Cls = getAdapterClass(row.provider);
    adapter = new Cls(connectionId, this._decryptConfig(row.config_json));
    await adapter.connect();
    this.adapters.set(connectionId, adapter);
    return adapter;
  }

  async getProjectAdapter(projectId, { connectionId = null, envId = null } = {}) {
    let row = null;
    if (connectionId) {
      row = this.ctx.system.get('SELECT * FROM db_connections WHERE id = ? AND project_id = ?', [connectionId, projectId]);
    } else if (envId) {
      row = this.ctx.system.get('SELECT * FROM db_connections WHERE project_id = ? AND env_id = ? ORDER BY is_default DESC LIMIT 1', [projectId, envId])
        || this.ctx.system.get('SELECT * FROM db_connections WHERE project_id = ? AND env_id IS NULL ORDER BY is_default DESC LIMIT 1', [projectId]);
    }
    if (!row) row = this.getDefaultConnection(projectId);
    if (!row) throw badRequest('This project has no database connection. Create one in Database → Connections.');
    return this.getAdapter(row.id);
  }

  async closeAdapter(connectionId) {
    const adapter = this.adapters.get(connectionId);
    if (adapter) {
      try { await adapter.disconnect(); } catch { /* best effort */ }
      this.adapters.delete(connectionId);
    }
  }

  async testConnection(provider, config) {
    const Cls = getAdapterClass(provider);
    const tmp = new Cls('test', config);
    try {
      const health = await tmp.health();
      return health;
    } catch (err) {
      return { status: 'down', provider, error: err.message };
    } finally {
      try { await tmp.disconnect(); } catch { }
    }
  }

  async refreshStatus(connectionId) {
    try {
      const adapter = await this.getAdapter(connectionId);
      const health = await adapter.health();
      this.ctx.system.run('UPDATE db_connections SET status = ?, last_error = ?, last_check_at = ? WHERE id = ?',
        [health.status === 'ok' ? 'ok' : 'down', health.error || null, new Date().toISOString(), connectionId]);
      return health;
    } catch (err) {
      this.ctx.system.run('UPDATE db_connections SET status = ?, last_error = ?, last_check_at = ? WHERE id = ?',
        ['down', err.message, new Date().toISOString(), connectionId]);
      return { status: 'down', error: err.message };
    }
  }

  startHealthMonitor() {
    if (this.monitor) return;
    this.monitor = setInterval(async () => {
      try {
        const rows = this.ctx.system.all('SELECT id FROM db_connections');
        for (const r of rows) await this.refreshStatus(r.id);
      } catch (err) {
        this.log.debug(`health monitor pass failed: ${err.message}`);
      }
    }, 60_000);
    this.monitor.unref?.();
  }

  // ── Activity + execution ──────────────────────────────────────────────────
  logActivity(projectId, connectionId, operation, detail = {}) {
    try {
      this.ctx.system.run('INSERT INTO db_activity (project_id, connection_id, operation, detail_json, created_at) VALUES (?,?,?,?,?)',
        [projectId, connectionId, operation, JSON.stringify(detail).slice(0, 4000), new Date().toISOString()]);
      // retention: keep last 5000 entries overall
      this.ctx.system.exec('DELETE FROM db_activity WHERE id NOT IN (SELECT id FROM db_activity ORDER BY id DESC LIMIT 5000)');
    } catch { /* activity log must never break queries */ }
  }

  async execute(connectionId, sql, params = [], { projectId = null, actor = 'dashboard', recordHistory = true } = {}) {
    const adapter = await this.getAdapter(connectionId);
    let result;
    let error = null;
    try {
      result = await adapter.query(sql, params);
    } catch (err) {
      error = err;
      result = { rows: [], rowCount: 0, durationMs: 0, columns: [], error: err.message };
    }
    if (recordHistory && projectId) {
      try {
        this.ctx.system.run(
          'INSERT INTO query_history (id, project_id, connection_id, sql, status, duration_ms, row_count, error, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [crypto.randomUUID(), projectId, connectionId, sql.slice(0, 8000),
            error ? 'error' : 'ok', result.durationMs || 0, result.rowCount || 0, error?.message || null,
            new Date().toISOString(), actor]
        );
        this.logActivity(projectId, connectionId, 'query', { sql: sql.slice(0, 200), status: error ? 'error' : 'ok', rows: result.rowCount });
      } catch { /* history is best-effort */ }
    }
    if (error) throw error;
    return result;
  }

  async schemaInspect(connectionId) {
    const adapter = await this.getAdapter(connectionId);
    const tables = await adapter.listTables();
    const out = [];
    for (const t of tables) {
      out.push({
        name: t.name,
        type: t.type,
        columns: await adapter.listColumns(t.name).catch(() => []),
        indexes: await adapter.listIndexes(t.name).catch(() => []),
        foreignKeys: await adapter.listForeignKeys(t.name).catch(() => []),
        size: await adapter.tableSize?.(t.name).catch(() => null) || null,
      });
    }
    return out;
  }

  async exportDump(connectionId) {
    const adapter = await this.getAdapter(connectionId);
    return adapter.dump();
  }

  async importDump(connectionId, sqlText) {
    const adapter = await this.getAdapter(connectionId);
    return adapter.executeFile(sqlText);
  }

  providersStatus() {
    return {
      catalog: PROVIDER_CATALOG,
      registered: listRegisteredAdapters(),
      drivers: null, // filled async by providersStatusAsync
    };
  }

  async providersStatusAsync() {
    return {
      catalog: PROVIDER_CATALOG,
      registered: listRegisteredAdapters(),
      drivers: await driverStatus(),
      sqliteEnabled: this.ctx.config.get('database.sqliteEnabled', true),
    };
  }

  async shutdown() {
    if (this.monitor) { clearInterval(this.monitor); this.monitor = null; }
    for (const [id] of this.adapters) {
      await this.closeAdapter(id);
    }
    try { this.ctx.system?.db?.close(); } catch { /* already closed */ }
  }
}

export async function register(ctx) {
  const manager = new DatabaseManager(ctx);
  manager.openSystemStore();
  manager.ensureSystemSchema();
  ctx.database = manager;
  ctx.log.info(`system store ready (${ctx.system.file})`);
}
