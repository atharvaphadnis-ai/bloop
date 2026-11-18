// modules/mysql-adapter.js — MySQL adapter via the optional "mysql2" driver.
import { BaseAdapter, registerAdapter, detectDriver } from './database-adapters.js';
import { AppError } from '../core/error-handler.js';
import { sanitizeIdentifier } from '../core/validation.js';

const SQL_TYPES = {
  text: 'TEXT', string: 'VARCHAR(255)', varchar: 'VARCHAR(255)', integer: 'INT', int: 'INT',
  bigint: 'BIGINT', boolean: 'TINYINT(1)', real: 'FLOAT', float: 'FLOAT', double: 'DOUBLE',
  numeric: 'DECIMAL(18,4)', json: 'JSON', datetime: 'DATETIME', date: 'DATE', time: 'TIME',
};

export class MySqlAdapter extends BaseAdapter {
  constructor(connectionId, config, providerId = 'mysql') {
    super(providerId, connectionId, config);
    this.conn = null;
  }

  static async driver() {
    const mod = await detectDriver('mysql2/promise');
    if (!mod) {
      throw new AppError(501, 'DRIVER_MISSING',
        'MySQL / MariaDB support requires the optional "mysql2" driver. Install it with: npm install mysql2');
    }
    return mod;
  }

  async connect() {
    if (this.conn) return this;
    const mysql = await MySqlAdapter.driver();
    this.conn = await mysql.createConnection({
      host: this.config.host,
      port: this.config.port || 3306,
      user: this.config.user,
      password: this.config.password || undefined,
      database: this.config.database,
      connectTimeout: 10_000,
      multipleStatements: false,
      namedPlaceholders: false,
    });
    this.connected = true;
    return this;
  }

  async disconnect() {
    if (this.conn) { try { await this.conn.end(); } catch { } this.conn = null; }
    this.connected = false;
  }

  async health() {
    try {
      await this.connect();
      const [rows] = await this.conn.query('SELECT VERSION() AS v');
      return { status: 'ok', provider: this.provider, version: rows[0].v };
    } catch (err) {
      this.connected = false;
      return { status: 'down', provider: this.provider, error: err.message };
    }
  }

  async query(sql, params = []) {
    await this.connect();
    const t0 = performance.now();
    try {
      const [rows, fields] = await this.conn.query(sql, params);
      const normalized = Array.isArray(rows) ? rows : [rows];
      return {
        rows: normalized,
        rowCount: normalized.length,
        durationMs: +(performance.now() - t0).toFixed(2),
        columns: fields?.map((f) => f.name) || (normalized.length ? Object.keys(normalized[0]) : []),
      };
    } catch (err) {
      throw this._wrap(err, sql);
    }
  }

  async exec(sql) { return this.query(sql); }

  _wrap(err, sql) {
    const e = new Error(`MySQL error: ${err.message} (sql: ${sql.slice(0, 120)})`);
    e.status = 400;
    e.code = 'SQL_ERROR';
    e.cause = err;
    return e;
  }

  async listTables() {
    const { rows } = await this.query(
      `SELECT table_name AS name, 'table' AS type FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name`
    );
    return rows;
  }

  async listColumns(table) {
    sanitizeIdentifier(table);
    const { rows } = await this.query(
      `SELECT column_name, data_type, is_nullable, column_default, column_key
       FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`,
      [table]
    );
    return rows.map((r) => ({
      name: r.column_name ?? r.COLUMN_NAME,
      type: r.data_type ?? r.DATA_TYPE,
      nullable: (r.is_nullable ?? r.IS_NULLABLE) === 'YES',
      default: r.column_default ?? r.COLUMN_DEFAULT,
      pk: (r.column_key ?? r.COLUMN_KEY) === 'PRI',
    }));
  }

  async listIndexes(table) {
    sanitizeIdentifier(table);
    const { rows } = await this.query(`SHOW INDEX FROM \`${table}\``);
    const map = new Map();
    for (const r of rows) {
      const name = r.Key_name;
      if (!map.has(name)) map.set(name, { name, unique: r.Non_unique === 0, columns: [] });
      map.get(name).columns.push(r.Column_name);
    }
    return [...map.values()];
  }

  async listForeignKeys(table) {
    sanitizeIdentifier(table);
    const { rows } = await this.query(
      `SELECT constraint_name AS name, column_name, referenced_table_name, referenced_column_name
       FROM information_schema.key_column_usage
       WHERE table_schema = DATABASE() AND table_name = ? AND referenced_table_name IS NOT NULL`,
      [table]
    );
    return rows;
  }

  async createTable({ name, columns = [], ifNotExists = false }) {
    sanitizeIdentifier(name);
    const defs = columns.map((c) => {
      sanitizeIdentifier(c.name);
      const type = c.autoIncrement ? 'INT AUTO_INCREMENT' : (SQL_TYPES[(c.type || 'text').toLowerCase()] || 'TEXT');
      let def = `\`${c.name}\` ${type}`;
      if (c.pk) def += ' PRIMARY KEY';
      if (c.unique && !c.pk) def += ' UNIQUE';
      if (c.nullable === false && !c.pk) def += ' NOT NULL';
      if (c.default !== undefined && c.default !== null && !c.autoIncrement) def += ` DEFAULT ${typeof c.default === 'number' ? c.default : `'${String(c.default).replace(/'/g, "''")}'`}`;
      if (c.references) def += ` REFERENCES \`${c.references.table}\`(\`${c.references.column}\`)`;
      return def;
    });
    const sql = `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}\`${name}\` (${defs.join(', ')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
    await this.exec(sql);
    return { sql };
  }

  async dropTable(name, { ifExists = false } = {}) {
    sanitizeIdentifier(name);
    await this.exec(`DROP TABLE ${ifExists ? 'IF EXISTS ' : ''}\`${name}\``);
    return { ok: true };
  }

  async renameTable(from, to) {
    sanitizeIdentifier(from); sanitizeIdentifier(to);
    await this.exec(`RENAME TABLE \`${from}\` TO \`${to}\``);
    return { ok: true };
  }

  async addColumn(table, column) {
    sanitizeIdentifier(table); sanitizeIdentifier(column.name);
    const type = SQL_TYPES[(column.type || 'text').toLowerCase()] || 'TEXT';
    await this.exec(`ALTER TABLE \`${table}\` ADD COLUMN \`${column.name}\` ${type}${column.nullable === false ? ' NOT NULL' : ''}`);
    return { ok: true };
  }

  async dropColumn(table, name) {
    sanitizeIdentifier(table); sanitizeIdentifier(name);
    await this.exec(`ALTER TABLE \`${table}\` DROP COLUMN \`${name}\``);
    return { ok: true };
  }

  async createIndex(table, { name, columns = [], unique = false }) {
    sanitizeIdentifier(table);
    if (!name) name = `idx_${table}_${columns.join('_')}`.slice(0, 60);
    sanitizeIdentifier(name);
    await this.exec(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX \`${name}\` ON \`${table}\` (${columns.map((c) => `\`${c}\``).join(', ')})`);
    return { ok: true, name };
  }

  async dropIndex(name, table) {
    sanitizeIdentifier(name);
    await this.exec(`DROP INDEX \`${name}\` ON \`${table}\``);
    return { ok: true };
  }

  async transaction(fn) {
    await this.connect();
    await this.conn.beginTransaction();
    try {
      const result = await fn(this);
      await this.conn.commit();
      return result;
    } catch (err) {
      await this.conn.rollback().catch(() => { });
      throw err;
    }
  }

  async explain(sql, params = []) {
    const { rows } = await this.query(`EXPLAIN ${sql}`, params);
    return { rows, rowCount: rows.length };
  }

  async tableSize(table) {
    sanitizeIdentifier(table);
    const { rows } = await this.query(
      `SELECT data_length + index_length AS bytes, table_rows AS row_count
       FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`, [table]
    );
    return { rows: Number(rows[0]?.row_count || 0), bytes: Number(rows[0]?.bytes || 0) };
  }

  async dump() {
    const tables = await this.listTables();
    const parts = ['-- Bloop MySQL data dump', `-- ${new Date().toISOString()}`, 'SET FOREIGN_KEY_CHECKS=0;', 'START TRANSACTION;'];
    for (const t of tables) {
      const cols = await this.listColumns(t.name);
      const colNames = cols.map((c) => `\`${c.name}\``).join(', ');
      const { rows } = await this.query(`SELECT * FROM \`${t.name}\``);
      for (const row of rows) {
        const vals = cols.map((c) => this._sqlValue(row[c.name]));
        parts.push(`INSERT INTO \`${t.name}\` (${colNames}) VALUES (${vals.join(', ')});`);
      }
    }
    parts.push('COMMIT;', 'SET FOREIGN_KEY_CHECKS=1;');
    return parts.join('\n');
  }

  _sqlValue(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
    if (Buffer.isBuffer(v)) return `'0x${v.toString('hex')}'`;
    if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
    return `'${String(v).replace(/'/g, "''")}'`;
  }
}

registerAdapter('mysql', MySqlAdapter);

export async function register(ctx) {
  ctx.log.debug?.('mysql-adapter registered (driver loaded on demand)');
}
