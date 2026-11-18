// modules/sqlite-adapter.js — full-featured embedded SQLite adapter built on
// Node's built-in node:sqlite (zero dependencies, WAL mode, parameterized
// queries, transactions, EXPLAIN, consistent-snapshot backups, SQL dumps).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { BaseAdapter, registerAdapter } from './database-adapters.js';
import { sanitizeIdentifier } from '../core/validation.js';

export const SQL_TYPE_MAP = {
  text: 'TEXT', string: 'TEXT', varchar: 'TEXT', integer: 'INTEGER', int: 'INTEGER',
  bigint: 'INTEGER', boolean: 'INTEGER', real: 'REAL', float: 'REAL', double: 'REAL',
  numeric: 'NUMERIC', json: 'TEXT', blob: 'BLOB', datetime: 'TEXT', date: 'TEXT', time: 'TEXT',
};

export class SQLiteAdapter extends BaseAdapter {
  constructor(connectionId, config) {
    super('sqlite', connectionId, config);
    this.db = null;
    this.filename = config?.filename || ':memory:';
    this.txQueue = Promise.resolve();
    this.lastOperationTs = 0;
  }

  async connect() {
    if (this.db) return this;
    if (this.filename !== ':memory:') {
      fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    }
    this.db = new DatabaseSync(this.filename);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.connected = true;
    return this;
  }

  async disconnect() {
    if (this.db) {
      try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
      this.db.close();
      this.db = null;
    }
    this.connected = false;
  }

  async health() {
    try {
      if (!this.db) await this.connect();
      const row = this.db.prepare('SELECT sqlite_version() AS v').get();
      const size = this.filename !== ':memory:' && fs.existsSync(this.filename) ? fs.statSync(this.filename).size : 0;
      return { status: 'ok', provider: 'sqlite', version: row.v, sizeBytes: size, file: this.filename };
    } catch (err) {
      this.connected = false;
      return { status: 'down', provider: 'sqlite', error: err.message };
    }
  }

  _prep(sql, params) {
    const stmt = this.db.prepare(sql);
    const safe = (params || []).map((p) => (p === undefined ? null : p));
    return stmt;
  }

  async query(sql, params = []) {
    if (!this.db) await this.connect();
    const t0 = performance.now();
    try {
      const stmt = this.db.prepare(sql);
      const bound = (params || []).map((p) => (p === undefined ? null : p));
      // write statements go through .run() so changes/lastInsertRowid are reported
      const isWrite = /^\s*(insert|update|delete|replace|create|drop|alter|vacuum|reindex)\b/i.test(sql);
      if (isWrite) {
        const info = stmt.run(...bound);
        this.lastOperationTs = Date.now();
        return { rows: [], rowCount: Number(info.changes), changes: Number(info.changes), lastInsertRowid: info.lastInsertRowid, durationMs: +(performance.now() - t0).toFixed(2), columns: [] };
      }
      const rows = stmt.all(...bound);
      this.lastOperationTs = Date.now();
      return {
        rows,
        rowCount: rows.length,
        durationMs: +(performance.now() - t0).toFixed(2),
        columns: rows.length ? Object.keys(rows[0]) : stmt.columns?.().map((c) => c.name) || [],
      };
    } catch (err) {
      throw this._wrapError(err, sql);
    }
  }

  async exec(sql) {
    if (!this.db) await this.connect();
    const t0 = performance.now();
    try {
      this.db.exec(sql);
      this.lastOperationTs = Date.now();
      return { ok: true, durationMs: +(performance.now() - t0).toFixed(2) };
    } catch (err) {
      throw this._wrapError(err, sql);
    }
  }

  async run(sql, params = []) {
    if (!this.db) await this.connect();
    const t0 = performance.now();
    try {
      const stmt = this.db.prepare(sql);
      const bound = (params || []).map((p) => (p === undefined ? null : p));
      const info = stmt.run(...bound);
      this.lastOperationTs = Date.now();
      return { changes: info.changes, lastInsertRowid: info.lastInsertRowid, durationMs: +(performance.now() - t0).toFixed(2) };
    } catch (err) {
      throw this._wrapError(err, sql);
    }
  }

  _wrapError(err, sql) {
    const e = new Error(`SQLite error: ${err.message} (sql: ${sql.slice(0, 120)})`);
    e.status = 400;
    e.code = 'SQL_ERROR';
    e.cause = err;
    return e;
  }

  async listTables() {
    const { rows } = await this.query(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_bloop_%' ORDER BY name"
    );
    return rows;
  }

  async listColumns(table) {
    sanitizeIdentifier(table);
    const rows = this.db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all();
    return rows.map((r) => ({
      name: r.name,
      type: r.type,
      nullable: r.notnull === 0,
      default: r.dflt_value,
      pk: r.pk > 0,
      pkPosition: r.pk,
    }));
  }

  async listIndexes(table) {
    sanitizeIdentifier(table);
    const idx = this.db.prepare(`PRAGMA index_list(${JSON.stringify(table)})`).all();
    const out = [];
    for (const i of idx) {
      const cols = this.db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all()
        .map((c) => c.name).filter(Boolean);
      out.push({ name: i.name, unique: i.unique === 1, origin: i.origin, columns: cols });
    }
    return out;
  }

  async listForeignKeys(table) {
    sanitizeIdentifier(table);
    return this.db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(table)})`).all().map((r) => ({
      column: r.from, referencesTable: r.table, referencesColumn: r.to, onUpdate: r.on_update, onDelete: r.on_delete,
    }));
  }

  async createTable({ name, columns = [], ifNotExists = false }) {
    sanitizeIdentifier(name);
    if (!columns.length) throw new Error('createTable requires at least one column');
    const defs = [];
    for (const c of columns) {
      sanitizeIdentifier(c.name);
      const type = SQL_TYPE_MAP[(c.type || 'text').toLowerCase()] || 'TEXT';
      let def = `"${c.name}" ${type}`;
      if (c.pk) def += ' PRIMARY KEY';
      if (c.autoIncrement && (type === 'INTEGER')) def = `"${c.name}" INTEGER PRIMARY KEY AUTOINCREMENT`;
      if (c.unique && !c.pk) def += ' UNIQUE';
      if (c.nullable === false && !c.pk) def += ' NOT NULL';
      if (c.default !== undefined && c.default !== null) {
        def += ` DEFAULT ${typeof c.default === 'number' ? c.default : `'${String(c.default).replace(/'/g, "''")}'`}`;
      }
      if (c.references) {
        sanitizeIdentifier(c.references.table);
        sanitizeIdentifier(c.references.column);
        def += ` REFERENCES "${c.references.table}"("${c.references.column}")`;
        if (c.references.onDelete) def += ` ON DELETE ${String(c.references.onDelete).toUpperCase()}`;
      }
      defs.push(def);
    }
    const sql = `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}"${name}" (\n  ${defs.join(',\n  ')}\n)`;
    await this.exec(sql);
    return { sql };
  }

  async dropTable(name, { ifExists = false } = {}) {
    sanitizeIdentifier(name);
    await this.exec(`DROP TABLE ${ifExists ? 'IF EXISTS ' : ''}"${name}"`);
    return { ok: true };
  }

  async renameTable(from, to) {
    sanitizeIdentifier(from); sanitizeIdentifier(to);
    await this.exec(`ALTER TABLE "${from}" RENAME TO "${to}"`);
    return { ok: true };
  }

  async addColumn(table, column) {
    sanitizeIdentifier(table); sanitizeIdentifier(column.name);
    const type = SQL_TYPE_MAP[(column.type || 'text').toLowerCase()] || 'TEXT';
    let def = `"${column.name}" ${type}`;
    if (column.nullable === false) def += ' NOT NULL DEFAULT ' + (column.default !== undefined ? `'${column.default}'` : "''");
    await this.exec(`ALTER TABLE "${table}" ADD COLUMN ${def}`);
    return { ok: true };
  }

  async dropColumn(table, name) {
    sanitizeIdentifier(table); sanitizeIdentifier(name);
    await this.exec(`ALTER TABLE "${table}" DROP COLUMN "${name}"`);
    return { ok: true };
  }

  async createIndex(table, { name, columns = [], unique = false }) {
    sanitizeIdentifier(table);
    if (!name) name = `idx_${table}_${columns.join('_')}`.slice(0, 60);
    sanitizeIdentifier(name);
    for (const c of columns) sanitizeIdentifier(c);
    const sql = `CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${name}" ON "${table}" (${columns.map((c) => `"${c}"`).join(', ')})`;
    await this.exec(sql);
    return { sql, name };
  }

  async dropIndex(name) {
    sanitizeIdentifier(name);
    await this.exec(`DROP INDEX IF EXISTS "${name}"`);
    return { ok: true };
  }

  /**
   * Transactions. The fn may be sync or async. Because SQLite runs on the
   * calling thread, sync fns execute atomically within one tick. Async fns
   * are serialized through a per-adapter queue.
   */
  async transaction(fn) {
    if (!this.db) await this.connect();
    const run = async () => {
      const savepoint = `sp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = await fn(this);
        this.db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (err) {
        try { this.db.exec(`ROLLBACK TO ${savepoint}`); this.db.exec(`RELEASE ${savepoint}`); } catch { /* already rolled back */ }
        throw err;
      }
    };
    // serialize concurrent async transactions
    const chained = this.txQueue.then(run, run);
    this.txQueue = chained.then(() => undefined, () => undefined);
    return chained;
  }

  async explain(sql, params = []) {
    return this.query(`EXPLAIN QUERY PLAN ${sql}`, params);
  }

  async tableSize(table) {
    sanitizeIdentifier(table);
    const r = this.db.prepare(`SELECT COUNT(*) AS rows FROM "${table}"`).get();
    const pg = this.db.prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get();
    return { rows: r.rows, bytes: pg?.bytes || 0 };
  }

  /** Consistent physical snapshot (used by the backup manager). */
  async backupToFile(destPath) {
    if (this.filename === ':memory:') throw new Error('in-memory databases cannot be file-backed up');
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await this.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
    return destPath;
  }

  /** Full SQL dump: schema + data (used by export / external-provider backups). */
  async dump() {
    const objects = this.db.prepare(
      "SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_bloop_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 2 ELSE 1 END, name"
    ).all();
    const parts = ['-- Bloop SQLite dump', `-- generated ${new Date().toISOString()}`, 'PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;'];
    for (const obj of objects) {
      parts.push(`${obj.sql};`);
      if (obj.type === 'table') {
        const rows = this.db.prepare(`SELECT * FROM "${obj.name}"`).all();
        if (rows.length) {
          const cols = Object.keys(rows[0]);
          const colList = cols.map((c) => `"${c}"`).join(', ');
          for (const row of rows) {
            const vals = cols.map((c) => {
              const v = row[c];
              if (v === null || v === undefined) return 'NULL';
              if (typeof v === 'number') return String(v);
              if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString('hex')}'`;
              return `'${String(v).replace(/'/g, "''")}'`;
            });
            parts.push(`INSERT INTO "${obj.name}" (${colList}) VALUES (${vals.join(', ')});`);
          }
        }
      }
    }
    parts.push('COMMIT;', 'PRAGMA foreign_keys=ON;');
    return parts.join('\n');
  }

  async executeFile(sqlText) {
    return this.exec(sqlText);
  }

  async getSchemaSummary() {
    const tables = await this.listTables();
    const out = [];
    for (const t of tables) {
      out.push({
        name: t.name,
        type: t.type,
        columns: await this.listColumns(t.name),
        indexes: await this.listIndexes(t.name),
        foreignKeys: await this.listForeignKeys(t.name),
      });
    }
    return out;
  }
}

registerAdapter('sqlite', SQLiteAdapter);

export async function register(ctx) {
  ctx.log.debug?.('sqlite-adapter ready (node:sqlite embedded)');
}
