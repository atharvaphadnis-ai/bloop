// modules/sql-editor.js — SQL Studio backend: multi-statement execution,
// formatting, autocomplete catalogs, history, saved queries, EXPLAIN,
// CSV/JSON export and transaction sessions.
import crypto from 'node:crypto';
import { badRequest, notFound } from '../core/error-handler.js';
import { validateOrThrow } from '../core/validation.js';

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM',
  'CREATE TABLE', 'CREATE INDEX', 'CREATE UNIQUE INDEX', 'CREATE VIEW', 'ALTER TABLE',
  'DROP TABLE', 'DROP INDEX', 'ADD COLUMN', 'RENAME TO', 'PRIMARY KEY', 'FOREIGN KEY',
  'REFERENCES', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'ON', 'GROUP BY',
  'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'UNION ALL', 'WITH', 'AS', 'AND',
  'OR', 'NOT', 'NULL', 'IS NULL', 'IN', 'BETWEEN', 'LIKE', 'EXISTS', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'DESC', 'ASC',
  'BEGIN TRANSACTION', 'COMMIT', 'ROLLBACK', 'EXPLAIN', 'VACUUM', 'PRAGMA',
];

export class SqlEditor {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'sql-editor' });
    this.sessions = new Map(); // sessionId -> {connectionId, savepoint?, startedAt}
    this.sessionSweeper = setInterval(() => {
      const cutoff = Date.now() - 30 * 60_000;
      for (const [id, s] of this.sessions) if (s.startedAt < cutoff) this.sessions.delete(id);
    }, 5 * 60_000);
    this.sessionSweeper.unref?.();
  }

  get db() { return this.ctx.system; }

  // ── Statement splitting (quote- and comment-aware) ────────────────────────
  splitStatements(sql) {
    const out = [];
    let current = '';
    let inSingle = false, inDouble = false, inLineComment = false, inBlockComment = false;
    for (let i = 0; i < sql.length; i++) {
      const c = sql[i], next = sql[i + 1];
      if (inLineComment) { current += c; if (c === '\n') inLineComment = false; continue; }
      if (inBlockComment) { current += c; if (c === '*' && next === '/') { current += next; i++; inBlockComment = false; } continue; }
      if (!inSingle && !inDouble && c === '-' && next === '-') { inLineComment = true; current += c; continue; }
      if (!inSingle && !inDouble && c === '/' && next === '*') { inBlockComment = true; current += c; continue; }
      if (c === "'" && !inDouble) { inSingle = !inSingle; current += c; continue; }
      if (c === '"' && !inSingle) { inDouble = !inDouble; current += c; continue; }
      if (c === ';' && !inSingle && !inDouble) {
        if (current.trim()) out.push(current.trim());
        current = '';
        continue;
      }
      current += c;
    }
    if (current.trim()) out.push(current.trim());
    return out;
  }

  async execute(projectId, connectionId, sql, { params = [], actor = 'dashboard', sessionId = null } = {}) {
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session || session.connectionId !== connectionId) throw badRequest('Unknown or expired transaction session');
    }
    const statements = this.splitStatements(sql);
    if (!statements.length) throw badRequest('No SQL statements to execute');
    const adapter = await this.ctx.database.getAdapter(connectionId);
    const results = [];
    const t0 = Date.now();
    for (const stmt of statements) {
      try {
        const r = await adapter.query(stmt, params);
        results.push({
          sql: stmt, rows: r.rows, rowCount: r.rowCount ?? r.rows?.length ?? 0,
          columns: r.columns || [], durationMs: r.durationMs, status: 'ok',
        });
        if (r.insertId || r.lastInsertRowid) results[results.length - 1].lastInsertRowid = r.lastInsertRowid;
        // live sync: mutating statements broadcast to realtime subscribers
        const wm = /^(?:INSERT\s+OR\s+\w+\s+INTO|INSERT\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+"?([A-Za-z0-9_]+)"?/i.exec(stmt);
        if (wm) {
          const wop = /^(?:INSERT|REPLACE)/i.test(stmt) ? 'insert' : /^UPDATE/i.test(stmt) ? 'update' : 'delete';
          try { this.ctx.realtime?.notifyDataChange(projectId, wm[1], wop, null); } catch { /* best-effort */ }
        }
      } catch (err) {
        results.push({ sql: stmt, rows: [], rowCount: 0, columns: [], status: 'error', error: err.message, durationMs: 0 });
        break; // stop at the first failed statement (documented behavior)
      }
    }
    const totalMs = Date.now() - t0;
    // history + activity
    try {
      const failed = results.find((r) => r.status === 'error');
      this.db.run(
        'INSERT INTO query_history (id, project_id, connection_id, sql, status, duration_ms, row_count, error, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [crypto.randomUUID(), projectId, connectionId, sql.slice(0, 8000), failed ? 'error' : 'ok', totalMs,
          results.reduce((a, r) => a + (r.rowCount || 0), 0), failed?.error || null, new Date().toISOString(), actor]
      );
      this.ctx.database.logActivity(projectId, connectionId, 'sql-editor', { statements: statements.length, ms: totalMs });
    } catch { /* best effort */ }
    return { results, totalMs, statementCount: statements.length, session: sessionId };
  }

  async explain(projectId, connectionId, sql) {
    const stmts = this.splitStatements(sql);
    if (stmts.length !== 1) throw badRequest('EXPLAIN takes exactly one statement');
    const adapter = await this.ctx.database.getAdapter(connectionId);
    return adapter.explain(stmts[0]);
  }

  // ── Formatting ────────────────────────────────────────────────────────────
  formatSql(sql) {
    const major = /^(SELECT|FROM|WHERE|AND|OR|ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|OFFSET|JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|OUTER\s+JOIN|FULL\s+JOIN|ON|UNION|UNION\s+ALL|INSERT\s+INTO|VALUES|UPDATE|SET|DELETE\s+FROM|CREATE\s+TABLE|CREATE\s+INDEX|ALTER\s+TABLE|DROP\s+TABLE|WITH)$/i;
    const tokens = sql.replace(/\s+/g, ' ').trim().split(' ');
    let out = '';
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const nextTok = (tokens[i + 1] || '').toUpperCase();
      let word = tok;
      // merge multi-word keywords like LEFT JOIN
      if (/^(LEFT|RIGHT|INNER|FULL|CROSS)$/i.test(tok) && /^JOIN$/i.test(nextTok)) {
        word = `${tok} ${tokens[++i]}`;
      }
      if (/^(CREATE|ALTER|DROP)$/i.test(tok) && /^(TABLE|INDEX|VIEW)$/i.test(nextTok)) {
        word = `${tok} ${tokens[++i]}`;
      }
      if (/^GROUP$/i.test(tok) && /^BY$/i.test(nextTok)) word = `${tok} ${tokens[++i]}`;
      if (/^ORDER$/i.test(tok) && /^BY$/i.test(nextTok)) word = `${tok} ${tokens[++i]}`;
      if (/^UNION$/i.test(tok) && /^ALL$/i.test(nextTok)) word = `${tok} ${tokens[++i]}`;
      if (/^INSERT$/i.test(tok) && /^INTO$/i.test(nextTok)) word = `${tok} ${tokens[++i]}`;
      if (/^DELETE$/i.test(tok) && /^FROM$/i.test(nextTok)) word = `${tok} ${tokens[++i]}`;
      if (/^BEGIN$/i.test(tok) && /^TRANSACTION$/i.test(nextTok)) word = `${tok} ${tokens[++i]}`;
      const isMajor = major.test(word) && depth === 0;
      if (isMajor && out && !out.endsWith('\n')) out += '\n';
      if (word === '(') { depth++; out += (out && !out.endsWith(' ') && !out.endsWith('\n') ? ' ' : '') + word; continue; }
      if (word === ')') { depth = Math.max(0, depth - 1); out += ' ' + word; continue; }
      if (out === '' || out.endsWith('\n')) out += word;
      else out += (out.endsWith('(') ? '' : ' ') + word;
    }
    return out.replace(/\s+,/g, ',').replace(/, /g, ',\n' + (depth ? '' : '')) // keep commas inline
      .replace(/\n\)/g, '\n)');
  }

  // ── Autocomplete ──────────────────────────────────────────────────────────
  async autocomplete(connectionId) {
    const adapter = await this.ctx.database.getAdapter(connectionId);
    const tables = await adapter.listTables().catch(() => []);
    const catalog = [];
    for (const t of tables.slice(0, 100)) {
      const cols = await adapter.listColumns(t.name).catch(() => []);
      catalog.push({ name: t.name, type: t.type, columns: cols.map((c) => ({ name: c.name, type: c.type })) });
    }
    return { tables: catalog, keywords: SQL_KEYWORDS };
  }

  // ── History ───────────────────────────────────────────────────────────────
  history(projectId, { connectionId = null, limit = 50 } = {}) {
    const rows = connectionId
      ? this.db.all('SELECT * FROM query_history WHERE project_id = ? AND connection_id = ? ORDER BY created_at DESC LIMIT ?', [projectId, connectionId, limit])
      : this.db.all('SELECT * FROM query_history WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', [projectId, limit]);
    return rows;
  }

  clearHistory(projectId) {
    this.db.run('DELETE FROM query_history WHERE project_id = ?', [projectId]);
    return { cleared: true };
  }

  // ── Saved queries ─────────────────────────────────────────────────────────
  saveQuery(projectId, input) {
    const data = validateOrThrow({
      name: { type: 'string', required: true, min: 1, max: 100 },
      sql: { type: 'string', required: true, max: 20000 },
      connectionId: { type: 'string' },
    }, input);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.run('INSERT INTO saved_queries (id, project_id, name, sql, connection_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      [id, projectId, data.name, data.sql, data.connectionId || null, now, now]);
    return this.getSavedQuery(projectId, id);
  }

  listSavedQueries(projectId) {
    return this.db.all('SELECT * FROM saved_queries WHERE project_id = ? ORDER BY updated_at DESC', [projectId]);
  }

  getSavedQuery(projectId, id) {
    const row = this.db.get('SELECT * FROM saved_queries WHERE id = ? AND project_id = ?', [id, projectId]);
    if (!row) throw notFound('Saved query not found');
    return row;
  }

  updateSavedQuery(projectId, id, patch) {
    const existing = this.getSavedQuery(projectId, id);
    const data = validateOrThrow({
      name: { type: 'string', min: 1, max: 100 },
      sql: { type: 'string', max: 20000 },
    }, patch);
    this.db.run('UPDATE saved_queries SET name = ?, sql = ?, updated_at = ? WHERE id = ?',
      [data.name ?? existing.name, data.sql ?? existing.sql, new Date().toISOString(), id]);
    return this.getSavedQuery(projectId, id);
  }

  deleteSavedQuery(projectId, id) {
    this.getSavedQuery(projectId, id);
    this.db.run('DELETE FROM saved_queries WHERE id = ?', [id]);
    return { deleted: true };
  }

  // ── Export ────────────────────────────────────────────────────────────────
  toCsv(rows) {
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]);
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') v = JSON.stringify(v);
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  }

  // ── Transaction sessions ──────────────────────────────────────────────────
  async beginSession(projectId, connectionId) {
    const adapter = await this.ctx.database.getAdapter(connectionId);
    const id = crypto.randomUUID();
    const session = { id, projectId, connectionId, startedAt: Date.now() };
    if (adapter.db) {
      // SQLite: named savepoint on the shared connection (single-threaded)
      const savepoint = `editor_${id.replace(/-/g, '')}`;
      adapter.db.exec(`SAVEPOINT ${savepoint}`);
      session.savepoint = savepoint;
    } else {
      await adapter.exec('BEGIN');
    }
    this.sessions.set(id, session);
    return { sessionId: id, provider: adapter.provider };
  }

  async commitSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw badRequest('Unknown transaction session');
    const adapter = await this.ctx.database.getAdapter(session.connectionId);
    if (session.savepoint) adapter.db.exec(`RELEASE ${session.savepoint}`);
    else await adapter.exec('COMMIT');
    this.sessions.delete(sessionId);
    return { committed: true };
  }

  async rollbackSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw badRequest('Unknown transaction session');
    const adapter = await this.ctx.database.getAdapter(session.connectionId);
    if (session.savepoint) {
      adapter.db.exec(`ROLLBACK TO ${session.savepoint}`);
      adapter.db.exec(`RELEASE ${session.savepoint}`);
    } else {
      await adapter.exec('ROLLBACK');
    }
    this.sessions.delete(sessionId);
    return { rolledBack: true };
  }
}

export async function register(ctx) {
  ctx.sqlEditor = new SqlEditor(ctx);
}
