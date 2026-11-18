// modules/database-branching.js — isolated database branches with honest,
// provider-aware strategies:
//   sqlite   → file clone (safe, native-grade for a single-file DB)
//   postgres → CREATE DATABASE ... TEMPLATE clone (requires privileges) or
//              fallback data dump-clone
//   mysql/mariadb → dump-clone (CREATE DATABASE + INSERT dump)
//   mongodb  → namespace clone (copy collections into a new database)
//   badger   → not supported (reported as such)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { badRequest, notFound, AppError } from '../core/error-handler.js';
import { providerMeta } from './database-adapters.js';

export class DatabaseBranching {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'branching' });
  }

  get db() { return this.ctx.system; }

  _branchStore() {
    const row = this.db.get("SELECT value_json FROM settings WHERE scope = 'branching' AND key = 'branches'");
    return row ? JSON.parse(row.value_json) : [];
  }

  _saveBranches(branches) {
    this.db.run(
      "INSERT INTO settings (scope, key, value_json, updated_at) VALUES ('branching','branches',?,?) " +
      'ON CONFLICT(scope, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
      [JSON.stringify(branches), new Date().toISOString()]
    );
  }

  list(projectId, connectionId) {
    const branches = this._branchStore().filter((b) => b.projectId === projectId && b.sourceConnectionId === connectionId);
    return branches.map((b) => {
      const live = this.db.get('SELECT id, status FROM db_connections WHERE id = ?', [b.connectionId]);
      return { ...b, connectionStatus: live?.status || 'deleted' };
    });
  }

  async create(projectId, connectionId, { branchName }) {
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(branchName)) throw badRequest('Branch name must be alphanumeric (dashes allowed)');
    const sourceRow = this.db.get('SELECT * FROM db_connections WHERE id = ? AND project_id = ?', [connectionId, projectId]);
    if (!sourceRow) throw notFound('Source connection not found');
    const strategy = providerMeta(sourceRow.provider)?.capabilities?.branching;
    if (!strategy || strategy === 'none') {
      throw new AppError(400, 'BRANCHING_UNSUPPORTED', `Branching is not supported for provider "${sourceRow.provider}".`);
    }
    const branchConnName = `branch:${branchName}`;
    if (this.db.get('SELECT id FROM db_connections WHERE project_id = ? AND name = ?', [projectId, branchConnName])) {
      throw badRequest(`Branch "${branchName}" already exists`);
    }
    let config;
    const now = new Date().toISOString();
    if (sourceRow.provider === 'sqlite') {
      const srcAdapter = await this.ctx.database.getAdapter(connectionId);
      await srcAdapter.exec('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => { });
      const srcCfg = JSON.parse(sourceRow.config_json);
      const dest = path.join(this.ctx.env.dataDir, 'projects', projectId, 'branches', `${branchName}.db`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(srcCfg.filename, dest);
      config = { filename: dest, embedded: true };
    } else if (sourceRow.provider === 'postgres') {
      config = await this._clonePostgres(sourceRow, branchName);
    } else if (sourceRow.provider === 'mysql' || sourceRow.provider === 'mariadb') {
      config = await this._cloneDump(sourceRow, branchName);
    } else if (sourceRow.provider === 'mongodb') {
      config = await this._cloneMongo(sourceRow, branchName);
    } else {
      throw new AppError(400, 'BRANCHING_UNSUPPORTED', `Provider "${sourceRow.provider}" does not support branching.`);
    }
    const id = crypto.randomUUID();
    this.db.run(
      'INSERT INTO db_connections (id, project_id, env_id, name, provider, config_json, is_default, status, created_at) VALUES (?,?,?,?,?,0,?,?,?)',
      [id, projectId, null, branchConnName, sourceRow.provider, JSON.stringify(this.ctx.database._encryptConfig(config)), 'ok', now]
    );
    const branches = this._branchStore();
    branches.push({
      id: crypto.randomUUID(), projectId, sourceConnectionId: connectionId, connectionId: id,
      name: branchName, provider: sourceRow.provider, strategy, createdAt: now,
    });
    this._saveBranches(branches);
    this.ctx.audit?.record({ actor: 'system', action: 'db.branch.create', projectId, target: branchName, meta: { strategy } });
    this.log.info(`branch "${branchName}" created (${strategy}) for connection ${connectionId}`);
    return { branch: branchName, strategy, connectionId: id };
  }

  async _clonePostgres(sourceRow, branchName) {
    const cfg = this.ctx.database._decryptConfig(sourceRow.config_json);
    // Try native TEMPLATE clone first; fall back to dump-clone with a note.
    try {
      const pg = await import('pg');
      const admin = new pg.Client({ host: cfg.host, port: cfg.port || 5432, user: cfg.user, password: cfg.password || undefined, database: 'postgres', connectionTimeoutMillis: 8000 });
      await admin.connect();
      const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [branchName]);
      if (exists.rows.length) throw badRequest(`Database "${branchName}" already exists on the server`);
      await admin.query(`CREATE DATABASE "${branchName}" TEMPLATE "${cfg.database}"`);
      await admin.end();
      return { ...cfg, database: branchName, strategy: 'database-clone' };
    } catch (err) {
      if (err?.status) throw err;
      // fall through to dump-clone
    }
    const dumpConn = await this.ctx.database.getAdapter(sourceRow.id);
    const dump = await dumpConn.dump();
    const pg = await import('pg');
    const admin = new pg.Client({ host: cfg.host, port: cfg.port || 5432, user: cfg.user, password: cfg.password || undefined, database: 'postgres', connectionTimeoutMillis: 8000 });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${branchName}"`);
    await admin.end();
    const branchClient = new pg.Client({ host: cfg.host, port: cfg.port || 5432, user: cfg.user, password: cfg.password || undefined, database: branchName, connectionTimeoutMillis: 8000 });
    await branchClient.connect();
    await branchClient.query(dump);
    await branchClient.end();
    return { ...cfg, database: branchName, strategy: 'dump-clone (TEMPLATE clone unavailable — check privileges)' };
  }

  async _cloneDump(sourceRow, branchName) {
    const cfg = this.ctx.database._decryptConfig(sourceRow.config_json);
    const source = await this.ctx.database.getAdapter(sourceRow.id);
    const dump = await source.dump();
    const branchCfg = { ...cfg, database: branchName };
    const Cls = (await import('./database-adapters.js')).getAdapterClass(sourceRow.provider);
    // mysql2/mariadb connections bind to a single database — open a fresh
    // connection pointed at the new database and replay the dump there.
    const fresh = new Cls('branch-clone', branchCfg);
    await fresh.connect();
    try {
      await fresh.exec(`CREATE DATABASE IF NOT EXISTS \`${branchName}\``).catch(() => { });
    } catch { /* database may have been created externally */ }
    await fresh.executeFile(dump);
    await fresh.disconnect();
    return { ...branchCfg, strategy: 'dump-clone' };
  }

  async _cloneMongo(sourceRow, branchName) {
    const cfg = this.ctx.database._decryptConfig(sourceRow.config_json);
    const source = await this.ctx.database.getAdapter(sourceRow.id);
    const dump = JSON.parse(await source.dump());
    const { MongoClient } = await import('mongodb');
    const base = cfg.url.replace(/\/([^/?]+)(\?.*)?$/, `/${branchName}$2`);
    const client = new MongoClient(base, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const branchDb = client.db(branchName);
    for (const [coll, docs] of Object.entries(dump.collections || {})) {
      if (docs.length) await branchDb.collection(coll).insertMany(docs);
    }
    await client.close();
    return { ...cfg, url: base, database: branchName, strategy: 'namespace-clone' };
  }

  /** Schema diff between two connections of SQL providers. */
  async compare(projectId, connectionIdA, connectionIdB) {
    const a = await this.ctx.database.getAdapter(connectionIdA);
    const b = await this.ctx.database.getAdapter(connectionIdB);
    const schemaA = await a.getSchemaSummary();
    const schemaB = await b.getSchemaSummary();
    const mapB = new Map(schemaB.map((t) => [t.name, t]));
    const mapA = new Map(schemaA.map((t) => [t.name, t]));
    const diff = { onlyInA: [], onlyInB: [], changedTables: [], identicalTables: [] };
    for (const t of schemaA) {
      if (!mapB.has(t.name)) { diff.onlyInA.push(t.name); continue; }
      const tb = mapB.get(t.name);
      const colsA = new Map(t.columns.map((c) => [c.name, c]));
      const colsB = new Map(tb.columns.map((c) => [c.name, c]));
      const colDiff = {
        addedInA: [...colsA.keys()].filter((c) => !colsB.has(c)),
        removedInA: [...colsB.keys()].filter((c) => !colsA.has(c)),
        typeChanged: [...colsA.keys()].filter((c) => colsB.has(c) && colsA.get(c).type !== colsB.get(c).type),
      };
      const idxA = t.indexes.map((i) => i.name), idxB = tb.indexes.map((i) => i.name);
      const indexDiff = { addedInA: idxA.filter((i) => !idxB.includes(i)), removedInA: idxB.filter((i) => !idxA.includes(i)) };
      const changed = colDiff.addedInA.length || colDiff.removedInA.length || colDiff.typeChanged.length || indexDiff.addedInA.length || indexDiff.removedInA.length;
      if (changed) diff.changedTables.push({ table: t.name, ...colDiff, indexes: indexDiff });
      else diff.identicalTables.push(t.name);
    }
    for (const t of schemaB) if (!mapA.has(t.name)) diff.onlyInB.push(t.name);
    return diff;
  }

  /**
   * Sync schema differences from source to target. Only additive DDL
   * (CREATE TABLE / ADD COLUMN / CREATE INDEX) is auto-generated; destructive
   * changes always require manual SQL — stated plainly in the output.
   */
  async sync(projectId, sourceConnectionId, targetConnectionId, { apply = false } = {}) {
    const source = await this.ctx.database.getAdapter(sourceConnectionId);
    const target = await this.ctx.database.getAdapter(targetConnectionId);
    const schemaSource = await source.getSchemaSummary();
    const schemaTarget = await target.getSchemaSummary();
    const existing = new Map(schemaTarget.map((t) => [t.name, t]));
    const statements = [];
    for (const t of schemaSource) {
      if (!existing.has(t.name)) {
        statements.push({ sql: this._createTableSql(source.provider, t), reason: `create table "${t.name}"` });
        continue;
      }
      const tgt = existing.get(t.name);
      const tgtCols = new Set(tgt.columns.map((c) => c.name));
      for (const c of t.columns) {
        if (!tgtCols.has(c.name)) {
          statements.push({ sql: this._addColumnSql(source.provider, t.name, c), reason: `add column "${c.name}" to "${t.name}"` });
        }
      }
      const tgtIdx = new Set(tgt.indexes.map((i) => i.name));
      for (const i of t.indexes) {
        if (!tgtIdx.has(i.name) && i.name && !i.name.startsWith('sqlite_autoindex')) {
          statements.push({ sql: this._createIndexSql(source.provider, t.name, i), reason: `create index "${i.name}"` });
        }
      }
    }
    const result = {
      statements,
      destructiveNote: 'Destructive differences (missing tables/columns in the source) are never auto-dropped — handle those manually with a migration.',
      applied: 0,
    };
    if (apply && statements.length) {
      await target.transaction(async (a) => {
        for (const s of statements) {
          await a.exec(s.sql);
          result.applied++;
        }
      });
      this.ctx.database.logActivity(projectId, targetConnectionId, 'branch.sync', { statements: statements.length });
    }
    return result;
  }

  async promote(projectId, branchConnectionId, targetConnectionId, { apply = false } = {}) {
    const res = await this.sync(projectId, branchConnectionId, targetConnectionId, { apply });
    this.ctx.audit?.record({ actor: 'system', action: 'db.branch.promote', projectId, target: targetConnectionId, meta: { branch: branchConnectionId, applied: res.applied } });
    return { ...res, promoted: res.applied > 0 || apply === false };
  }

  async deleteBranch(projectId, branchName) {
    const branches = this._branchStore();
    const branch = branches.find((b) => b.projectId === projectId && b.name === branchName);
    if (!branch) throw notFound('Branch not found');
    const row = this.db.get('SELECT * FROM db_connections WHERE id = ?', [branch.connectionId]);
    if (row) {
      await this.ctx.database.closeAdapter(row.id);
      if (row.provider === 'sqlite') {
        const cfg = JSON.parse(row.config_json);
        if (cfg.filename) fs.rmSync(cfg.filename, { force: true });
      } else if (row.provider === 'mysql' || row.provider === 'mariadb') {
        try {
          const adapter = await this.ctx.database.getAdapter(branch.connectionId);
          await adapter.exec(`DROP DATABASE IF EXISTS \`${branchName}\``);
        } catch { /* server may already be gone */ }
      } else if (row.provider === 'postgres') {
        try {
          const adapter = await this.ctx.database.getAdapter(branch.connectionId);
          await adapter.exec(`DROP DATABASE IF EXISTS "${branchName}" WITH (FORCE)`);
        } catch { }
      }
      this.db.run('DELETE FROM db_connections WHERE id = ?', [branch.connectionId]);
    }
    this._saveBranches(branches.filter((b) => b !== branch));
    return { deleted: true, name: branchName };
  }

  _createTableSql(provider, tableDef) {
    const q = provider === 'mysql' || provider === 'mariadb' ? (s) => '`' + s + '`' : (s) => '"' + s + '"';
    const cols = tableDef.columns.map((c) => {
      let def = `${q(c.name)} ${c.type || 'TEXT'}`;
      if (c.pk) def += ' PRIMARY KEY';
      if (c.nullable === false && !c.pk) def += ' NOT NULL';
      return def;
    });
    const fks = (tableDef.foreignKeys || []).map((fk) =>
      provider === 'mysql' || provider === 'mariadb'
        ? `FOREIGN KEY (${q(fk.column ?? fk.column_name)}) REFERENCES ${q(fk.referencesTable ?? fk.referenced_table_name)}(${q(fk.referencesColumn ?? fk.referenced_column_name)})`
        : ''
    ).filter(Boolean);
    return `CREATE TABLE IF NOT EXISTS ${q(tableDef.name)} (\n  ${[...cols, ...fks].join(',\n  ')}\n)`;
  }

  _addColumnSql(provider, table, col) {
    const q = provider === 'mysql' || provider === 'mariadb' ? (s) => '`' + s + '`' : (s) => '"' + s + '"';
    return `ALTER TABLE ${q(table)} ADD COLUMN ${q(col.name)} ${col.type || 'TEXT'}`;
  }

  _createIndexSql(provider, table, idx) {
    const q = provider === 'mysql' || provider === 'mariadb' ? (s) => '`' + s + '`' : (s) => '"' + s + '"';
    const cols = idx.columns?.length ? idx.columns : [];
    if (!cols.length) return null;
    return `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${q(idx.name)} ON ${q(table)} (${cols.map(q).join(', ')})`;
  }
}

export async function register(ctx) {
  ctx.branching = new DatabaseBranching(ctx);
}
