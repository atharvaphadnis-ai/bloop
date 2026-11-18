// modules/postgres-adapter.js — PostgreSQL adapter via the optional "pg" driver.
// When the driver is missing, every operation fails with actionable guidance
// instead of pretending to work.
import { BaseAdapter, registerAdapter, detectDriver } from './database-adapters.js';
import { AppError } from '../core/error-handler.js';
import { sanitizeIdentifier } from '../core/validation.js';

const SQL_TYPES = {
  text: 'TEXT', string: 'TEXT', varchar: 'TEXT', integer: 'INTEGER', int: 'INTEGER',
  bigint: 'BIGINT', boolean: 'BOOLEAN', real: 'REAL', float: 'DOUBLE PRECISION',
  double: 'DOUBLE PRECISION', numeric: 'NUMERIC', json: 'JSONB', datetime: 'TIMESTAMPTZ',
  date: 'DATE', time: 'TIME', uuid: 'UUID',
};

export class PostgresAdapter extends BaseAdapter {
  constructor(connectionId, config) {
    super('postgres', connectionId, config);
    this.client = null;
  }

  static async driver() {
    const mod = await detectDriver('pg');
    if (!mod) {
      throw new AppError(501, 'DRIVER_MISSING',
        'PostgreSQL support requires the optional "pg" driver. Install it with: npm install pg');
    }
    return mod;
  }

  async connect() {
    if (this.client) return this;
    const pg = await PostgresAdapter.driver();
    this.client = new pg.Client({
      host: this.config.host,
      port: this.config.port || 5432,
      user: this.config.user,
      password: this.config.password || undefined,
      database: this.config.database,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 10_000,
      max: this.config.poolMax || 5,
    });
    await this.client.connect();
    this.connected = true;
    return this;
  }

  async disconnect() {
    if (this.client) { try { await this.client.end(); } catch { } this.client = null; }
    this.connected = false;
  }

  async health() {
    try {
      await this.connect();
      const r = await this.client.query('SELECT version() AS v');
      return { status: 'ok', provider: 'postgres', version: String(r.rows[0].v).split(' ').slice(0, 2).join(' ') };
    } catch (err) {
      this.connected = false;
      return { status: 'down', provider: 'postgres', error: err.message };
    }
  }

  async query(sql, params = []) {
    await this.connect();
    const t0 = performance.now();
    try {
      const r = await this.client.query(sql, params);
      return {
        rows: r.rows,
        rowCount: r.rowCount ?? r.rows.length,
        durationMs: +(performance.now() - t0).toFixed(2),
        columns: r.fields?.map((f) => f.name) || [],
      };
    } catch (err) {
      throw this._wrap(err, sql);
    }
  }

  async exec(sql) {
    return this.query(sql);
  }

  _wrap(err, sql) {
    const e = new Error(`PostgreSQL error: ${err.message} (sql: ${sql.slice(0, 120)})`);
    e.status = 400;
    e.code = 'SQL_ERROR';
    e.cause = err;
    return e;
  }

  async listTables() {
    const { rows } = await this.query(
      "SELECT table_name AS name, 'table' AS type FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name"
    );
    return rows;
  }

  async listColumns(table) {
    sanitizeIdentifier(table);
    const { rows } = await this.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
      [table]
    );
    return rows.map((r) => ({
      name: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES', default: r.column_default, pk: false,
    }));
  }

  async listIndexes(table) {
    sanitizeIdentifier(table);
    const { rows } = await this.query(
      `SELECT indexname AS name, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1`,
      [table]
    );
    return rows.map((r) => ({ name: r.name, unique: /UNIQUE INDEX/i.test(r.indexdef), columns: [], definition: r.indexdef }));
  }

  async listForeignKeys(table) {
    sanitizeIdentifier(table);
    const { rows } = await this.query(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'f'`, [`"${table}"`]
    );
    return rows;
  }

  async createTable({ name, columns = [], ifNotExists = false }) {
    sanitizeIdentifier(name);
    const defs = columns.map((c) => {
      sanitizeIdentifier(c.name);
      const type = c.serial ? 'SERIAL' : (SQL_TYPES[(c.type || 'text').toLowerCase()] || 'TEXT');
      let def = `"${c.name}" ${type}`;
      if (c.pk) def += ' PRIMARY KEY';
      if (c.unique && !c.pk) def += ' UNIQUE';
      if (c.nullable === false && !c.pk) def += ' NOT NULL';
      if (c.default !== undefined && c.default !== null && !c.serial) def += ` DEFAULT ${typeof c.default === 'number' ? c.default : `'${String(c.default).replace(/'/g, "''")}'`}`;
      if (c.references) def += ` REFERENCES "${c.references.table}"("${c.references.column}")`;
      return def;
    });
    const sql = `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}"${name}" (${defs.join(', ')})`;
    await this.exec(sql);
    return { sql };
  }

  async dropTable(name, { ifExists = false, cascade = false } = {}) {
    sanitizeIdentifier(name);
    await this.exec(`DROP TABLE ${ifExists ? 'IF EXISTS ' : ''}"${name}"${cascade ? ' CASCADE' : ''}`);
    return { ok: true };
  }

  async renameTable(from, to) {
    sanitizeIdentifier(from); sanitizeIdentifier(to);
    await this.exec(`ALTER TABLE "${from}" RENAME TO "${to}"`);
    return { ok: true };
  }

  async addColumn(table, column) {
    sanitizeIdentifier(table); sanitizeIdentifier(column.name);
    const type = SQL_TYPES[(column.type || 'text').toLowerCase()] || 'TEXT';
    await this.exec(`ALTER TABLE "${table}" ADD COLUMN "${column.name}" ${type}${column.nullable === false ? ' NOT NULL' : ''}`);
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
    await this.exec(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${name}" ON "${table}" (${columns.map((c) => `"${c}"`).join(', ')})`);
    return { ok: true, name };
  }

  async dropIndex(name) {
    sanitizeIdentifier(name);
    await this.exec(`DROP INDEX IF EXISTS "${name}"`);
    return { ok: true };
  }

  async transaction(fn) {
    await this.connect();
    await this.client.query('BEGIN');
    try {
      const result = await fn(this);
      await this.client.query('COMMIT');
      return result;
    } catch (err) {
      await this.client.query('ROLLBACK').catch(() => { });
      throw err;
    }
  }

  async explain(sql, params = []) {
    const { rows } = await this.query(`EXPLAIN ${sql}`, params);
    return { rows: rows.map((r) => ({ plan: Object.values(r)[0] })), rowCount: rows.length };
  }

  async tableSize(table) {
    sanitizeIdentifier(table);
    const { rows } = await this.query(
      `SELECT pg_total_relation_size($1) AS bytes, (SELECT COUNT(*) FROM "${table}") AS row_count`, [table]
    );
    return { rows: Number(rows[0].row_count), bytes: Number(rows[0].bytes) };
  }

  async dump() {
    // Data dump via INSERT statements; for full logical backups prefer pg_dump
    // (documented in the backups guide). This dump covers all base tables of
    // the current schema.
    const tables = await this.listTables();
    const parts = ['-- Bloop PostgreSQL data dump', `-- ${new Date().toISOString()}`, 'BEGIN;'];
    for (const t of tables) {
      const cols = await this.listColumns(t.name);
      const colNames = cols.map((c) => `"${c.name}"`).join(', ');
      const { rows } = await this.query(`SELECT * FROM "${t.name}"`);
      for (const row of rows) {
        const vals = cols.map((c) => this._sqlValue(row[c.name]));
        parts.push(`INSERT INTO "${t.name}" (${colNames}) VALUES (${vals.join(', ')});`);
      }
    }
    parts.push('COMMIT;');
    return parts.join('\n');
  }

  _sqlValue(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v instanceof Date) return `'${v.toISOString()}'`;
    if (Buffer.isBuffer(v)) return `decode('${v.toString('hex')}', 'hex')`;
    if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
    return `'${String(v).replace(/'/g, "''")}'`;
  }
}

registerAdapter('postgres', PostgresAdapter);

export async function register(ctx) {
  ctx.log.debug?.('postgres-adapter registered (driver loaded on demand)');
}
