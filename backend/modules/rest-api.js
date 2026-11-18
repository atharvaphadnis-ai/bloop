// modules/rest-api.js — automatic REST APIs generated from database schemas:
// CRUD with filtering (eq/neq/gt/gte/lt/lte/like/in/is), ordering, pagination,
// count, single-level relationship embedding, row-level security, request
// validation, per-key rate limiting, versioned paths (/api/v1), custom
// function endpoints and an OpenAPI 3 document per project.
import crypto from 'node:crypto';
import { badRequest, notFound, AppError } from '../core/error-handler.js';
import { sanitizeIdentifier } from '../core/validation.js';

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'count', 'embed', 'apikey', 'on_conflict']);
const OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'in', 'is']);

export class RestApi {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'rest-api' });
  }

  quote(provider, ident) {
    return (provider === 'mysql' || provider === 'mariadb') ? '`' + ident + '`' : '"' + ident + '"';
  }

  async resolveContext(req) {
    const projectId = req.params.projectId;
    const project = this.ctx.projects.get(projectId);
    const connRow = req.query?.conn
      ? this.ctx.system.get('SELECT * FROM db_connections WHERE id = ? AND project_id = ?', [req.query.conn, projectId])
      : this.ctx.database.getDefaultConnection(projectId);
    if (!connRow) throw badRequest('Project has no default database connection');
    if (!['sqlite', 'postgres', 'mysql', 'mariadb'].includes(connRow.provider)) {
      throw new AppError(501, 'PROVIDER_UNSUPPORTED',
        `The data REST API works on SQL providers. "${connRow.provider}" is document/KV-oriented — use the NoSQL API at /api/v1/${projectId}/nosql.`);
    }
    const adapter = await this.ctx.database.getAdapter(connRow.id);
    return { projectId, project, connRow, adapter, provider: connRow.provider };
  }

  async getSchema(adapter, provider, table) {
    sanitizeIdentifier(table);
    const columns = await adapter.listColumns(table).catch(() => null);
    if (!columns || !columns.length) throw notFound(`Table "${table}" not found`);
    const pk = columns.find((c) => c.pk) || columns.find((c) => c.name === 'id') || null;
    return { table, columns, pk: pk?.name || null };
  }

  parseFilters(req, schema) {
    const filters = [];
    const colNames = new Set(schema.columns.map((c) => c.name));
    for (const [key, value] of Object.entries(req.query || {})) {
      if (RESERVED.has(key)) continue;
      let column = key, op = 'eq';
      const lastDot = key.lastIndexOf('.');
      if (lastDot > 0) {
        const maybeOp = key.slice(lastDot + 1);
        if (OPERATORS.has(maybeOp) && colNames.has(key.slice(0, lastDot))) {
          column = key.slice(0, lastDot);
          op = maybeOp;
        }
      }
      if (!colNames.has(column)) continue; // unknown columns are ignored (documented)
      let finalValue = Array.isArray(value) ? String(value[0]) : String(value);
      // also accept "column=eq.value" (operator embedded in the value)
      const m = /^(eq|neq|gt|gte|lt|lte|like|in|is)\.(.*)$/.exec(finalValue);
      if (m && op === 'eq') {
        op = m[1];
        finalValue = m[2];
      }
      filters.push({ column, op, value: finalValue });
    }
    return filters;
  }

  buildWhere(filters, provider, offset = 0) {
    const q = (id) => this.quote(provider, id);
    const clauses = [];
    const params = [];
    for (const f of filters) {
      switch (f.op) {
        case 'eq': clauses.push(`${q(f.column)} = ?`); params.push(f.value); break;
        case 'neq': clauses.push(`${q(f.column)} <> ?`); params.push(f.value); break;
        case 'gt': clauses.push(`${q(f.column)} > ?`); params.push(f.value); break;
        case 'gte': clauses.push(`${q(f.column)} >= ?`); params.push(f.value); break;
        case 'lt': clauses.push(`${q(f.column)} < ?`); params.push(f.value); break;
        case 'lte': clauses.push(`${q(f.column)} <= ?`); params.push(f.value); break;
        case 'like': clauses.push(`${q(f.column)} LIKE ?`); params.push(f.value); break;
        case 'in': {
          const values = String(f.value).split(',').map((v) => v.trim()).filter(Boolean);
          if (!values.length) continue;
          clauses.push(`${q(f.column)} IN (${values.map(() => '?').join(', ')})`);
          params.push(...values);
          break;
        }
        case 'is':
          if (f.value === 'null') clauses.push(`${q(f.column)} IS NULL`);
          else if (f.value === 'notnull' || f.value === '!null') clauses.push(`${q(f.column)} IS NOT NULL`);
          else { clauses.push(`${q(f.column)} = ?`); params.push(f.value); }
          break;
      }
    }
    return { clause: clauses.length ? clauses.join(' AND ') : null, params, offset };
  }

  validateRow(schema, body, { partial = false } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Request body must be a JSON object');
    const errors = [];
    const out = {};
    const colMap = new Map(schema.columns.map((c) => [c.name, c]));
    for (const [k, v] of Object.entries(body)) {
      const col = colMap.get(k);
      if (!col) { errors.push(`unknown column "${k}"`); continue; }
      const type = (col.type || 'text').toUpperCase();
      if (v === null) {
        if (!col.nullable) errors.push(`column "${k}" is not nullable`);
        else out[k] = null;
        continue;
      }
      if (/INT|SERIAL/.test(type)) {
        const n = Number(v);
        if (!Number.isInteger(n)) errors.push(`column "${k}" expects an integer`);
        else out[k] = n;
      } else if (/REAL|FLOAT|DOUBLE|DEC|NUM/.test(type)) {
        const n = Number(v);
        if (Number.isNaN(n)) errors.push(`column "${k}" expects a number`);
        else out[k] = n;
      } else if (/BOOL/.test(type)) {
        out[k] = v === true || v === 'true' || v === 1 ? 1 : v === false || v === 'false' || v === 0 ? 0 : null;
        if (out[k] === null) errors.push(`column "${k}" expects a boolean`);
      } else {
        out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
      }
    }
    if (!partial) {
      for (const c of schema.columns) {
        if (!c.nullable && c.default === null && c.pk !== true && !(c.name in out)) {
          // no default and not provided — SQLite/Postgres may reject; pre-check for clarity
          if (!/DEFAULT/.test(c.default ?? '') && c.default === null && c.name !== 'created_at' && c.name !== 'updated_at') {
            errors.push(`missing required column "${c.name}"`);
          }
        }
      }
    }
    if (errors.length) throw badRequest('Row validation failed', errors);
    return out;
  }

  async list(req) {
    const { projectId, adapter, provider } = await this.resolveContext(req);
    const table = req.params.table;
    const schema = await this.getSchema(adapter, provider, table);
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 1000);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
    const filters = this.parseFilters(req, schema);
    const { clause, params } = this.buildWhere(filters, provider);

    // row-level security
    const policy = this.ctx.policies.sqlWhere(projectId, table, 'select', req.principal);
    const whereParts = [clause, policy?.clause].filter(Boolean);
    const whereSql = whereParts.length ? ' WHERE ' + whereParts.join(' AND ') : '';
    const allParams = [...params, ...(policy?.params || [])];

    const select = (req.query.select ? String(req.query.select).split(',').map((s) => s.trim()).filter((c) => schema.columns.some((col) => col.name === c)) : null);
    const colSql = select ? select.map((c) => this.quote(provider, c)).join(', ') : '*';
    const baseSql = `SELECT ${colSql} FROM ${this.quote(provider, table)}`;

    let orderSql = '';
    if (req.query.order) {
      const parts = String(req.query.order).split('.'); // e.g. created_at.desc
      const col = parts[0];
      if (schema.columns.some((c) => c.name === col)) {
        const dir = parts[1] === 'desc' ? 'DESC' : 'ASC';
        orderSql = ` ORDER BY ${this.quote(provider, col)} ${dir}`;
      }
    }
    const sql = `${baseSql}${whereSql}${orderSql} LIMIT ${limit} OFFSET ${offset}`;
    const result = await adapter.query(sql, allParams);
    let rows = result.rows;

    // count (honest count honoring the same filters)
    let count = null;
    if (req.query.count === 'exact' || req.query.count === 'true') {
      const countResult = await adapter.query(`SELECT COUNT(*) AS c FROM ${this.quote(provider, table)}${whereSql}`, allParams);
      count = Number(countResult.rows[0]?.c ?? 0);
    }

    // relationship embedding (?embed=table via FK, single level)
    if (req.query.embed) {
      const embedTable = String(req.query.embed);
      rows = await this._embed(adapter, provider, schema, table, rows, embedTable, allParams);
    }

    const res = { data: rows, limit, offset };
    if (count !== null) res.count = count;
    return res;
  }

  async _embed(adapter, provider, schema, table, rows, embedTable, parentParams) {
    const fks = await adapter.listForeignKeys(table).catch(() => []);
    const fk = fks.find((f) => (f.referencesTable || f.referenced_table_name) === embedTable)
      || (await adapter.listForeignKeys(embedTable).catch(() => [])).find((f) => (f.referencesTable || f.referenced_table_name) === table);
    if (!fk) throw badRequest(`No relationship found between "${table}" and "${embedTable}"`);
    sanitizeIdentifier(embedTable);
    const isParent = (f.referencesTable || f.referenced_table_name) === embedTable;
    const localCol = isParent ? (fk.column || fk.column_name) : (fk.referencesColumn || fk.referenced_column_name);
    const remoteCol = isParent ? (fk.referencesColumn || fk.referenced_column_name) : (fk.column || fk.column_name);
    const values = [...new Set(rows.map((r) => r[localCol]).filter((v) => v !== null && v !== undefined))];
    if (!values.length) return rows.map((r) => ({ ...r, [embedTable]: isParent ? null : [] }));
    const placeholders = values.map(() => '?').join(', ');
    const related = await adapter.query(
      `SELECT * FROM ${this.quote(provider, embedTable)} WHERE ${this.quote(provider, remoteCol)} IN (${placeholders})`, values
    );
    const byKey = new Map();
    for (const rel of related.rows) {
      const key = rel[remoteCol];
      if (isParent) byKey.set(key, rel);
      else {
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(rel);
      }
    }
    return rows.map((r) => ({ ...r, [embedTable]: byKey.get(r[localCol]) ?? (isParent ? null : []) }));
  }

  async getOne(req) {
    const { projectId, adapter, provider } = await this.resolveContext(req);
    const table = req.params.table;
    const schema = await this.getSchema(adapter, provider, table);
    if (!schema.pk) throw badRequest(`Table "${table}" has no primary key column`);
    const policy = this.ctx.policies.sqlWhere(projectId, table, 'select', req.principal);
    const whereParts = [`${this.quote(provider, schema.pk)} = ?`, policy?.clause].filter(Boolean);
    const params = [req.params.pkValue, ...(policy?.params || [])];
    const result = await adapter.query(`SELECT * FROM ${this.quote(provider, table)} WHERE ${whereParts.join(' AND ')} LIMIT 1`, params);
    if (!result.rows.length) throw notFound('Row not found');
    return { data: result.rows[0] };
  }

  async insert(req) {
    const { projectId, adapter, provider, connRow } = await this.resolveContext(req);
    const table = req.params.table;
    const schema = await this.getSchema(adapter, provider, table);
    const bodies = Array.isArray(req.body) ? req.body : [req.body];
    if (!bodies.length) throw badRequest('Empty insert payload');
    const inserted = [];
    for (const body of bodies) {
      const row = this.validateRow(schema, body);
      if (!this.ctx.policies.checkRow(projectId, table, 'insert', row, req.principal)) {
        throw forbidden('Insert blocked by row-level security policy');
      }
      const cols = Object.keys(row);
      if (!cols.length) throw badRequest('Nothing to insert');
      const sql = `INSERT INTO ${this.quote(provider, table)} (${cols.map((c) => this.quote(provider, c)).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      const runResult = await adapter.query(sql, cols.map((c) => row[c]));
      const outRow = { ...row };
      if (schema.pk && runResult.lastInsertRowid !== undefined && outRow[schema.pk] === undefined) {
        outRow[schema.pk] = Number(runResult.lastInsertRowid);
      }
      inserted.push(outRow);
      await this._emitChange(projectId, connRow, table, 'insert', outRow);
    }
    return { data: Array.isArray(req.body) ? inserted : inserted[0], inserted: inserted.length };
  }

  async update(req) {
    const { projectId, adapter, provider, connRow } = await this.resolveContext(req);
    const table = req.params.table;
    const schema = await this.getSchema(adapter, provider, table);
    const row = this.validateRow(schema, req.body, { partial: true });
    const setCols = Object.keys(row);
    if (!setCols.length) throw badRequest('Nothing to update');

    const filters = this.parseFilters(req, schema);
    if (req.params.pkValue) {
      if (!schema.pk) throw badRequest('Table has no primary key column');
      filters.push({ column: schema.pk, op: 'eq', value: req.params.pkValue });
    }
    if (!filters.length) throw badRequest('Updates require at least one filter or a row id — mass updates are blocked');
    const { clause, params } = this.buildWhere(filters, provider);
    const policy = this.ctx.policies.sqlWhere(projectId, table, 'update', req.principal);
    const whereParts = [clause, policy?.clause].filter(Boolean);

    // RLS per-row check on existing rows
    if (!req.principal?.bypassRls && this.ctx.policies.policiesFor(projectId, table).length) {
      const existing = await adapter.query(`SELECT * FROM ${this.quote(provider, table)} WHERE ${whereParts.join(' AND ')} LIMIT 1000`, [...params, ...(policy?.params || [])]);
      for (const old of existing.rows) {
        if (!this.ctx.policies.checkRow(projectId, table, 'update', { before: old, after: { ...old, ...row } }, req.principal)) {
          throw forbidden('Update blocked by row-level security policy');
        }
      }
    }

    const sql = `UPDATE ${this.quote(provider, table)} SET ${setCols.map((c) => `${this.quote(provider, c)} = ?`).join(', ')} WHERE ${whereParts.join(' AND ')}`;
    const result = await adapter.query(sql, [...setCols.map((c) => row[c]), ...params, ...(policy?.params || [])]);
    await this._emitChange(projectId, connRow, table, 'update', row);
    return { updated: result.rowCount ?? result.changes ?? result.rows?.length ?? 0 };
  }

  async upsert(req) {
    const { projectId, adapter, provider } = await this.resolveContext(req);
    const table = req.params.table;
    const schema = await this.getSchema(adapter, provider, table);
    if (!schema.pk) throw badRequest('Upsert requires a primary key column');
    const row = this.validateRow(schema, req.body);
    if (!(schema.pk in row)) throw badRequest(`Upsert payload must include the primary key "${schema.pk}"`);
    const existing = await adapter.query(
      `SELECT ${this.quote(provider, schema.pk)} FROM ${this.quote(provider, table)} WHERE ${this.quote(provider, schema.pk)} = ? LIMIT 1`,
      [row[schema.pk]]
    );
    if (existing.rows.length) {
      const cols = Object.keys(row).filter((c) => c !== schema.pk);
      if (cols.length) {
        await adapter.query(
          `UPDATE ${this.quote(provider, table)} SET ${cols.map((c) => `${this.quote(provider, c)} = ?`).join(', ')} WHERE ${this.quote(provider, schema.pk)} = ?`,
          [...cols.map((c) => row[c]), row[schema.pk]]
        );
      }
      return { upserted: row[schema.pk], action: 'update' };
    }
    const cols = Object.keys(row);
    await adapter.query(
      `INSERT INTO ${this.quote(provider, table)} (${cols.map((c) => this.quote(provider, c)).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map((c) => row[c])
    );
    return { upserted: row[schema.pk], action: 'insert' };
  }

  async remove(req) {
    const { projectId, adapter, provider, connRow } = await this.resolveContext(req);
    const table = req.params.table;
    const schema = await this.getSchema(adapter, provider, table);
    const filters = this.parseFilters(req, schema);
    if (req.params.pkValue) {
      if (!schema.pk) throw badRequest('Table has no primary key column');
      filters.push({ column: schema.pk, op: 'eq', value: req.params.pkValue });
    }
    if (!filters.length) throw badRequest('Deletes require at least one filter or a row id — mass deletes are blocked');
    const { clause, params } = this.buildWhere(filters, provider);
    const policy = this.ctx.policies.sqlWhere(projectId, table, 'delete', req.principal);
    const whereParts = [clause, policy?.clause].filter(Boolean);
    if (!req.principal?.bypassRls && this.ctx.policies.policiesFor(projectId, table).length) {
      const existing = await adapter.query(`SELECT * FROM ${this.quote(provider, table)} WHERE ${whereParts.join(' AND ')} LIMIT 1000`, [...params, ...(policy?.params || [])]);
      for (const old of existing.rows) {
        if (!this.ctx.policies.checkRow(projectId, table, 'delete', old, req.principal)) {
          throw forbidden('Delete blocked by row-level security policy');
        }
      }
    }
    const result = await adapter.query(`DELETE FROM ${this.quote(provider, table)} WHERE ${whereParts.join(' AND ')}`, [...params, ...(policy?.params || [])]);
    await this._emitChange(projectId, connRow, table, 'delete', null);
    return { deleted: result.rowCount ?? result.changes ?? 0 };
  }

  async _emitChange(projectId, connRow, table, op, after) {
    try {
      this.ctx.realtime?.notifyDataChange(projectId, table, op, after ? [after] : null);
    } catch { /* events are best-effort */ }
    try {
      await this.ctx.cdc?.recordChange({
        projectId,
        provider: connRow.provider,
        connectionId: connRow.id,
        table,
        op,
        after,
      });
    } catch { /* events are best-effort */ }
  }

  // ── OpenAPI generation ────────────────────────────────────────────────────
  async openapi(req) {
    const projectId = req.params.projectId;
    const project = this.ctx.projects.get(projectId);
    const connRow = this.ctx.database.getDefaultConnection(projectId);
    if (!connRow) throw badRequest('Project has no default database connection');
    const adapter = await this.ctx.database.getAdapter(connRow.id);
    const tables = await adapter.listTables().catch(() => []);
    const paths = {};
    const schemas = {};
    for (const t of tables.slice(0, 100)) {
      const columns = await adapter.listColumns(t.name).catch(() => []);
      const props = {};
      const required = [];
      for (const c of columns) {
        const type = /INT|SERIAL/.test(String(c.type).toUpperCase()) ? 'integer'
          : /REAL|FLOAT|DOUBLE|DEC|NUM/.test(String(c.type).toUpperCase()) ? 'number'
            : /BOOL/.test(String(c.type).toUpperCase()) ? 'boolean' : 'string';
        props[c.name] = { type, nullable: !!c.nullable };
        if (!c.nullable && !c.default) required.push(c.name);
      }
      schemas[t.name] = { type: 'object', properties: props, required };
      const tag = { tags: [t.name] };
      paths[`/db/${t.name}`] = {
        get: { summary: `List ${t.name} rows`, parameters: this._listParams(columns), responses: { '200': { description: 'Rows' } }, ...tag },
        post: { summary: `Insert into ${t.name}`, requestBody: { content: { 'application/json': { schema: { $ref: `#/components/schemas/${t.name}` } } } }, responses: { '200': { description: 'Inserted' } }, ...tag },
        patch: { summary: `Update ${t.name} rows (filters required)`, parameters: this._listParams(columns), responses: { '200': { description: 'Updated count' } }, ...tag },
        delete: { summary: `Delete ${t.name} rows (filters required)`, parameters: this._listParams(columns), responses: { '200': { description: 'Deleted count' } }, ...tag },
        put: { summary: `Upsert into ${t.name}`, responses: { '200': { description: 'Upserted' } }, ...tag },
      };
      paths[`/db/${t.name}/{pk}`] = {
        get: { summary: `Get one ${t.name} row by primary key`, responses: { '200': { description: 'Row' } }, ...tag },
        delete: { summary: `Delete one ${t.name} row by primary key`, responses: { '200': { description: 'Deleted' } }, ...tag },
      };
    }
    return {
      openapi: '3.0.3',
      info: {
        title: `Bloop API — ${project.name}`,
        version: '1.0.0',
        description: 'Auto-generated REST API. Authenticate with Authorization: Bearer <user JWT> or an API key (bk_...). Filters use column.operator=value query params (eq, neq, gt, gte, lt, lte, like, in, is).',
      },
      servers: [{ url: `/api/v1/${projectId}` }],
      paths,
      components: { schemas },
    };
  }

  _listParams(columns) {
    return [
      { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 1000 } },
      { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
      { name: 'order', in: 'query', schema: { type: 'string', example: 'created_at.desc' } },
      { name: 'count', in: 'query', schema: { type: 'string', enum: ['exact', 'true'] } },
      { name: 'select', in: 'query', schema: { type: 'string', example: columns.map((c) => c.name).slice(0, 3).join(',') } },
      { name: 'embed', in: 'query', schema: { type: 'string' } },
      ...columns.map((c) => ({ name: `${c.name}.eq`, in: 'query', schema: { type: 'string' }, description: `Filter: ${c.name} equals value (operators: eq,neq,gt,gte,lt,lte,like,in,is)` })),
    ];
  }
}

export async function register(ctx) {
  ctx.restApi = new RestApi(ctx);
}

export function mountRoutes(ctx) {
  const r = ctx.router;
  const REST = () => ctx.restApi;
  const opts = { auth: 'project' };

  r.get('/api/v1/:projectId/openapi.json', async (req, res) => {
    res.json(200, await REST().openapi(req));
  }, opts);

  r.get('/api/v1/:projectId/db/:table', async (req, res) => {
    ctx.authorization.scopeCheck(req.principal, 'db', 'read');
    res.json(200, await REST().list(req));
  }, opts);
  r.get('/api/v1/:projectId/db/:table/:pkValue', async (req, res) => {
    ctx.authorization.scopeCheck(req.principal, 'db', 'read');
    res.json(200, await REST().getOne(req));
  }, opts);
  r.post('/api/v1/:projectId/db/:table', async (req, res) => {
    ctx.authorization.scopeCheck(req.principal, 'db', 'write');
    res.json(200, await REST().insert(req));
  }, opts);
  r.patch('/api/v1/:projectId/db/:table', async (req, res) => {
    ctx.authorization.scopeCheck(req.principal, 'db', 'write');
    res.json(200, await REST().update(req));
  }, opts);
  r.patch('/api/v1/:projectId/db/:table/:pkValue', async (req, res) => {
    ctx.authorization.scopeCheck(req.principal, 'db', 'write');
    res.json(200, await REST().update(req));
  }, opts);
  r.put('/api/v1/:projectId/db/:table', async (req, res) => {
    ctx.authorization.scopeCheck(req.principal, 'db', 'write');
    res.json(200, await REST().upsert(req));
  }, opts);
  r.delete('/api/v1/:projectId/db/:table/:pkValue', async (req, res) => {
    ctx.authorization.scopeCheck(req.principal, 'db', 'write');
    res.json(200, await REST().remove(req));
  }, opts);
  r.delete('/api/v1/:projectId/db/:table', async (req, res) => {
    ctx.authorization.scopeCheck(req.principal, 'db', 'write');
    res.json(200, await REST().remove(req));
  }, opts);

  // Custom endpoints → server-side functions
  r.add('ALL', '/api/v1/:projectId/x/*', async (req, res) => {
    const projectId = req.params.projectId;
    const subPath = req.params.splat || '';
    const endpoints = ctx.system.all('SELECT * FROM custom_endpoints WHERE project_id = ? AND enabled = 1', [projectId]);
    const ep = endpoints.find((e) => e.path === subPath && (e.method === req.method || e.method === 'ANY'));
    if (!ep) throw notFound('Custom endpoint not found');
    if (ep.auth_required && req.principal.type === 'anon') throw unauthorized('This endpoint requires authentication');
    const fn = ctx.system.get('SELECT * FROM functions WHERE id = ?', [ep.function_id]);
    if (!fn) throw notFound('Function backing this endpoint was removed');
    const result = await ctx.functions.invoke(projectId, fn.slug, {
      trigger: 'endpoint',
      event: {
        method: req.method, path: subPath,
        query: req.query, body: req.body, principal: { userId: req.principal.userId, role: req.principal.role },
      },
      req,
    });
    const status = result.status === 'ok' ? 200 : 500;
    res.json(status, result);
  }, opts);
}
