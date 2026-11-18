// modules/graphql.js — auto-generated GraphQL API built from database schemas.
// A compact but genuine GraphQL implementation (lexer → parser → executor →
// introspection subset), no dependencies: queries, mutations, variables,
// fragments, aliases, relationships, pagination, error formatting and a
// playground-compatible endpoint. Subscriptions are not exposed over this
// HTTP endpoint — realtime table channels are provided by the Realtime engine
// (documented honestly in the API response when a subscription is attempted).
import { badRequest, notFound, AppError } from '../core/error-handler.js';

const RESERVED_QUERY_ARGS = new Set(['limit', 'offset', 'where', 'order']);

// ── Lexer ────────────────────────────────────────────────────────────────────
function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/[\s,]/.test(c)) { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '{' || c === '}' || c === '(' || c === ')' || c === '[' || c === ']' || c === ':' || c === '=' || c === '!' || c === '$' || c === '@' || c === '|') {
      tokens.push({ kind: c, value: c }); i++; continue;
    }
    if (c === '.') {
      if (src.slice(i, i + 3) === '...') { tokens.push({ kind: 'SPREAD', value: '...' }); i += 3; continue; }
      throw new Error(`Unexpected character "." at ${i}`);
    }
    if (c === '"' || c === '"') {
      const quote = c;
      let out = '';
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          i++;
          const e = src[i];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'u'
            ? String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16)) : e;
          i += e === 'u' ? 5 : 1;
          continue;
        }
        out += src[i];
        i++;
      }
      if (i >= src.length) throw new Error('Unterminated string');
      i++;
      tokens.push({ kind: 'STRING', value: out });
      continue;
    }
    if (/[_A-Za-z0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j])) j++;
      const word = src.slice(i, j);
      i = j;
      if (/^-?\d/.test(word) || /^-/.test(word)) tokens.push({ kind: 'NUMBER', value: parseFloat(word) });
      else tokens.push({ kind: 'NAME', value: word });
      continue;
    }
    if (c === '-' || /\d/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\d.eE+-]/.test(src[j])) j++;
      tokens.push({ kind: 'NUMBER', value: parseFloat(src.slice(i, j)) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character "${c}" at ${i}`);
  }
  tokens.push({ kind: 'EOF', value: null });
  return tokens;
}

// ── Parser ───────────────────────────────────────────────────────────────────
function parseDocument(src) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const expect = (kind) => {
    const t = peek();
    if (t.kind !== kind) throw new Error(`Expected ${kind} but found ${t.kind} (${t.value})`);
    pos++;
    return t;
  };
  const maybe = (kind) => (peek().kind === kind ? (pos++, tokens[pos - 1]) : null);

  function parseDocument() {
    const definitions = [];
    while (peek().kind !== 'EOF') {
      if (peek().kind === 'NAME' && ['query', 'mutation', 'subscription'].includes(peek().value)) {
        definitions.push(parseOperation());
      } else if (peek().kind === '{') {
        definitions.push({ kind: 'Operation', operation: 'query', name: null, selectionSet: parseSelectionSet() });
      } else if (peek().kind === 'NAME' && peek().value === 'fragment') {
        definitions.push(parseFragment());
      } else {
        throw new Error(`Unexpected token ${peek().value}`);
      }
    }
    return { definitions };
  }

  function parseOperation() {
    const operation = expect('NAME').value;
    let name = null;
    if (peek().kind === 'NAME') name = expect('NAME').value;
    const variableDefinitions = [];
    if (peek().kind === '(') {
      expect('(');
      while (peek().kind !== ')') {
        expect('$');
        const varName = expect('NAME').value;
        expect(':');
        const type = parseType();
        let defaultValue = null;
        if (peek().kind === '=') { pos++; defaultValue = parseValue(true); }
        variableDefinitions.push({ name: varName, type, default: defaultValue });
      }
      expect(')');
    }
    skipDirectives();
    const selectionSet = parseSelectionSet();
    return { kind: 'Operation', operation, name, variableDefinitions, selectionSet };
  }

  function parseFragment() {
    expect('NAME'); // 'fragment'
    const name = expect('NAME').value;
    expect('NAME'); // 'on'
    const typeCondition = expect('NAME').value;
    skipDirectives();
    const selectionSet = parseSelectionSet();
    return { kind: 'Fragment', name, typeCondition, selectionSet };
  }

  function parseType() {
    let type;
    if (peek().kind === '[') {
      pos++;
      const inner = parseType();
      expect(']');
      type = { kind: 'LIST', ofType: inner };
    } else {
      type = { kind: 'NAMED', name: expect('NAME').value };
    }
    if (peek().kind === '!') { pos++; type = { kind: 'NON_NULL', ofType: type }; }
    return type;
  }

  function skipDirectives() {
    while (peek().kind === '@') {
      pos++;
      expect('NAME');
      if (peek().kind === '(') {
        pos++;
        while (peek().kind !== ')') { if (peek().kind === '$') pos++; else if (peek().kind === ':') pos++; else if (peek().kind === '!' || peek().kind === '=') pos++; else pos++; }
        expect(')');
      }
    }
  }

  function parseSelectionSet() {
    expect('{');
    const selections = [];
    while (peek().kind !== '}') {
      if (peek().kind === 'SPREAD') {
        pos++;
        if (peek().kind === 'NAME' && peek().value === 'on') {
          pos++;
          const typeCondition = expect('NAME').value;
          skipDirectives();
          selections.push({ kind: 'InlineFragment', typeCondition, selectionSet: parseSelectionSet() });
        } else {
          selections.push({ kind: 'FragmentSpread', name: expect('NAME').value });
        }
      } else {
        selections.push(parseField());
      }
    }
    expect('}');
    return { selections };
  }

  function parseField() {
    let name = expect('NAME').value;
    let alias = null;
    if (peek().kind === ':') { pos++; alias = name; name = expect('NAME').value; }
    const args = [];
    if (peek().kind === '(') {
      pos++;
      while (peek().kind !== ')') {
        const argName = expect('NAME').value;
        expect(':');
        args.push({ name: argName, value: parseValue(false) });
      }
      expect(')');
    }
    skipDirectives();
    let selectionSet = null;
    if (peek().kind === '{') selectionSet = parseSelectionSet();
    return { kind: 'Field', alias, name, args, selectionSet };
  }

  function parseValue(isConst) {
    const t = peek();
    if (t.kind === '$') {
      if (isConst) throw new Error('Variables not allowed here');
      pos++;
      return { kind: 'Variable', name: expect('NAME').value };
    }
    if (t.kind === 'STRING') { pos++; return { kind: 'Literal', value: t.value }; }
    if (t.kind === 'NUMBER') { pos++; return { kind: 'Literal', value: t.value }; }
    if (t.kind === 'NAME') {
      pos++;
      if (t.value === 'true') return { kind: 'Literal', value: true };
      if (t.value === 'false') return { kind: 'Literal', value: false };
      if (t.value === 'null') return { kind: 'Literal', value: null };
      return { kind: 'EnumValue', value: t.value };
    }
    if (t.kind === '[') {
      pos++;
      const items = [];
      while (peek().kind !== ']') items.push(parseValue(isConst));
      expect(']');
      return { kind: 'List', values: items };
    }
    if (t.kind === '{') {
      pos++;
      const fields = [];
      while (peek().kind !== '}') {
        const key = expect('NAME').value;
        expect(':');
        fields.push({ name: key, value: parseValue(isConst) });
      }
      expect('}');
      return { kind: 'Object', fields };
    }
    throw new Error(`Unexpected value token ${t.kind}`);
  }

  return parseDocument();
}

// ── Schema descriptor (per project, cached) ──────────────────────────────────
function gqlName(name) {
  return name.replace(/[^_A-Za-z0-9]/g, '_').replace(/^(\d)/, '_$1');
}
function gqlTypeName(name) {
  const base = gqlName(name);
  return base.charAt(0).toUpperCase() + base.slice(1);
}

class GraphqlService {
  constructor(ctx) {
    this.ctx = ctx;
    this.schemaCache = new Map();
  }

  async schemaFor(projectId, { fresh = false } = {}) {
    if (!fresh && this.schemaCache.has(projectId)) return this.schemaCache.get(projectId);
    const connRow = this.ctx.database.getDefaultConnection(projectId);
    if (!connRow) throw badRequest('Project has no default database connection');
    if (!['sqlite', 'postgres', 'mysql', 'mariadb'].includes(connRow.provider)) {
      throw new AppError(501, 'PROVIDER_UNSUPPORTED', 'GraphQL data generation currently supports SQL providers. For MongoDB use the NoSQL API.');
    }
    const adapter = await this.ctx.database.getAdapter(connRow.id);
    const tables = await adapter.listTables();
    const schema = { tables: new Map(), fks: new Map() };
    for (const t of tables) {
      const columns = await adapter.listColumns(t.name);
      const pk = columns.find((c) => c.pk)?.name || null;
      const fks = await adapter.listForeignKeys(t.name).catch(() => []);
      schema.tables.set(t.name, { name: t.name, columns, pk, fks });
    }
    for (const [name, t] of schema.tables) {
      for (const fk of t.fks) {
        const refTable = fk.referencesTable || fk.referenced_table_name;
        if (!schema.tables.has(refTable)) continue;
        const local = fk.column || fk.column_name;
        const remote = fk.referencesColumn || fk.referenced_column_name;
        if (!schema.fks.has(name)) schema.fks.set(name, []);
        schema.fks.get(name).push({ kind: 'toOne', field: refTable, local, remote, target: refTable });
        if (!schema.fks.has(refTable)) schema.fks.set(refTable, []);
        schema.fks.get(refTable).push({ kind: 'toMany', field: name, local, remote, target: name, viaColumn: local });
      }
    }
    this.schemaCache.set(projectId, schema);
    return schema;
  }

  invalidate(projectId) {
    this.schemaCache.delete(projectId);
  }

  scalarType(col) {
    const t = String(col.type || 'text').toUpperCase();
    if (/INT|SERIAL/.test(t)) return 'Int';
    if (/REAL|FLOAT|DOUBLE|DEC|NUM/.test(t)) return 'Float';
    if (/BOOL/.test(t)) return 'Boolean';
    if (col.pk) return 'ID';
    return 'String';
  }

  // ── Introspection subset ──────────────────────────────────────────────────
  introspection(schema, typeName = null) {
    const types = [];
    const typeRef = (name) => ({ name, kind: name === 'Int' || name === 'Float' || name === 'String' || name === 'Boolean' || name === 'ID' ? 'SCALAR' : 'OBJECT' });
    const Query = { name: 'Query', kind: 'OBJECT', fields: [] };
    const Mutation = { name: 'Mutation', kind: 'OBJECT', fields: [] };
    for (const [name, t] of schema.tables) {
      const fields = t.columns.map((c) => ({ name: c.name, type: { name: this.scalarType(c), kind: 'SCALAR' } }));
      const rels = schema.fks.get(name) || [];
      for (const rel of rels) {
        if (rel.kind === 'toOne') fields.push({ name: rel.field, type: { name: gqlName(rel.target), kind: 'OBJECT' } });
        else fields.push({ name: rel.field, type: { name: `[${gqlName(rel.target)}]`, kind: 'LIST' } });
      }
      types.push({ name: gqlTypeName(name), kind: 'OBJECT', fields });
      Query.fields.push({ name: name, type: { name: `[${gqlTypeName(name)}]`, kind: 'LIST' } });
      Query.fields.push({ name: `${gqlTypeName(name)}ByPk`, type: { name: gqlTypeName(name), kind: 'OBJECT' } });
      Mutation.fields.push({ name: `insert${gqlTypeName(name)}`, type: { name: `[${gqlTypeName(name)}]`, kind: 'LIST' } });
      Mutation.fields.push({ name: `update${gqlTypeName(name)}`, type: { name: 'Int', kind: 'SCALAR' } });
      Mutation.fields.push({ name: `delete${gqlTypeName(name)}`, type: { name: 'Int', kind: 'SCALAR' } });
    }
    types.unshift(Query, Mutation);
    const all = [
      ...types,
      { name: 'Int', kind: 'SCALAR', fields: null },
      { name: 'Float', kind: 'SCALAR', fields: null },
      { name: 'String', kind: 'SCALAR', fields: null },
      { name: 'Boolean', kind: 'SCALAR', fields: null },
      { name: 'ID', kind: 'SCALAR', fields: null },
    ];
    if (typeName) {
      const found = all.find((t) => t.name === typeName);
      return found ? { kind: found.kind, name: found.name, fields: found.fields } : null;
    }
    return {
      queryType: { name: 'Query' },
      mutationType: { name: 'Mutation' },
      subscriptionType: null,
      types: all,
    };
  }

  // ── Execution ─────────────────────────────────────────────────────────────
  async execute(req) {
    const projectId = req.params.projectId;
    const body = req.body || {};
    const queryText = body.query;
    if (!queryText) throw badRequest('Provide a GraphQL "query" string');
    const variables = body.variables || {};
    const operationName = body.operationName || null;
    const schema = await this.schemaFor(projectId);
    const doc = parseDocument(queryText);

    const fragments = new Map();
    let operation = null;
    for (const def of doc.definitions) {
      if (def.kind === 'Fragment') fragments.set(def.name, def);
      else if (!operationName || def.name === operationName) operation = def;
    }
    if (!operation) throw badRequest(operationName ? `Operation "${operationName}" not found` : 'No operation found');
    if (operation.operation === 'subscription') {
      // GraphQL-style error: HTTP 200 with an errors array (per the spec)
      return { errors: [{ message: 'GraphQL subscriptions run over the Realtime engine: open a WebSocket to /realtime/v1 and subscribe to channel "project:<projectId>:db:<table>". This HTTP endpoint supports queries and mutations.' }] };
    }
    // bind variables
    const varValues = {};
    for (const v of operation.variableDefinitions || []) {
      const provided = variables[v.name];
      varValues[v.name] = provided !== undefined ? provided : v.default !== null ? valueOf(v.default, {}) : undefined;
    }

    const errors = [];
    const data = {};
    const adapter = await this.ctx.database.getAdapter(this.ctx.database.getDefaultConnection(projectId).id);
    for (const sel of operation.selectionSet.selections) {
      if (sel.kind === 'FragmentSpread' || sel.kind === 'InlineFragment') {
        const resolved = resolveFragment(sel, fragments, schema, 'Query');
        for (const inner of resolved) await this._execRootField(inner, data, errors, { schema, adapter, projectId, varValues, fragments, operationKind: operation.operation });
        continue;
      }
      await this._execRootField(sel, data, errors, { schema, adapter, projectId, varValues, fragments, operationKind: operation.operation });
    }
    if (errors.length) return { errors, data: Object.keys(data).length ? data : null };
    return { data };
  }

  async _execRootField(sel, data, errors, envx) {
    const { schema, adapter, projectId, varValues, fragments, operationKind } = envx;
    const fieldName = sel.name;
    const alias = sel.alias || fieldName;
    const args = argsOf(sel.args, varValues);
    try {
      if (fieldName === '__schema') {
        data[alias] = this.introspection(schema);
        return;
      }
      if (fieldName === '__typename') {
        data[alias] = operationKind === 'mutation' ? 'Mutation' : 'Query';
        return;
      }
      if (fieldName === '__type') {
        data[alias] = this.introspection(schema, args.name || null);
        return;
      }
      const tableMatch = matchTableOp(schema, fieldName);
      if (!tableMatch) {
        errors.push({ message: `Unknown field "${fieldName}" on ${operationKind === 'mutation' ? 'Mutation' : 'Query'}`, path: [alias] });
        data[alias] = null;
        return;
      }
      const principal = reqPrincipal(this.ctx, projectId);
      const isMutation = /^(insert|update|delete)/.test(fieldName);
      if (isMutation && operationKind !== 'mutation') {
        errors.push({ message: `Field "${fieldName}" is a mutation — send it in a "mutation" operation`, path: [alias] });
        data[alias] = null;
        return;
      }
      if (!isMutation && operationKind === 'mutation') {
        errors.push({ message: `Field "${fieldName}" is a query — send it in a "query" operation`, path: [alias] });
        data[alias] = null;
        return;
      }
      data[alias] = await this._runTableOp(adapter, projectId, principal, schema, tableMatch, args, sel, fragments);
    } catch (err) {
      errors.push({ message: err.message, path: [alias] });
      data[alias] = null;
    }
  }

  async _runTableOp(adapter, projectId, principal, schema, op, args, sel, fragments) {
    const tName = op.table;
    const t = schema.tables.get(tName);
    const q = (id) => adapter.provider === 'mysql' || adapter.provider === 'mariadb' ? '`' + id + '`' : '"' + id + '"';

    if (op.kind === 'query') {
      let rows;
      if (op.mode === 'byPk') {
        if (!t.pk) throw badRequest(`Table "${tName}" has no primary key`);
        const policy = this.ctx.policies.sqlWhere(projectId, tName, 'select', principal);
        const whereParts = [`${q(t.pk)} = ?`, policy?.clause].filter(Boolean);
        const result = await adapter.query(
          `SELECT * FROM ${q(tName)} WHERE ${whereParts.join(' AND ')} LIMIT 1`,
          [args.pk ?? args[t.pk], ...(policy?.params || [])]
        );
        rows = result.rows;
        if (!rows.length) return null;
        return await this._resolveSelection(adapter, projectId, principal, schema, t, rows[0], sel.selectionSet, fragments, 0);
      }
      const limit = Math.min(Number(args.limit ?? 50), 200);
      const offset = Math.max(Number(args.offset ?? 0), 0);
      const filters = typeof args.where === 'string' ? JSON.parse(args.where || '{}') : (args.where || {});
      const { clause, params } = this.ctx.restApi.buildWhere(this.ctx.restApi.parseFilters({ query: filters }, { columns: t.columns }), adapter.provider);
      const policy = this.ctx.policies.sqlWhere(projectId, tName, 'select', principal);
      const whereParts = [clause, policy?.clause].filter(Boolean);
      const orderSql = args.order && t.columns.some((c) => c.name === String(args.order).split('.')[0])
        ? ` ORDER BY ${q(String(args.order).split('.')[0])} ${String(args.order).split('.')[1] === 'desc' ? 'DESC' : 'ASC'}` : '';
      const result = await adapter.query(
        `SELECT * FROM ${q(tName)}${whereParts.length ? ' WHERE ' + whereParts.join(' AND ') : ''}${orderSql} LIMIT ${limit} OFFSET ${offset}`,
        [...params, ...(policy?.params || [])]
      );
      const out = [];
      let idx = 0;
      for (const row of result.rows) {
        out.push(await this._resolveSelection(adapter, projectId, principal, schema, t, row, sel.selectionSet, fragments, idx++));
      }
      return out;
    }

    // ── Mutations ───────────────────────────────────────────────────────────
    if (op.mode === 'insert') {
      const objects = args.objects ?? args.input;
      if (!Array.isArray(objects) || !objects.length) throw badRequest(`insert${gqlName(tName)} needs "objects: [...]`);
      const inserted = [];
      for (const obj of objects) {
        const { cols, values } = columnsFromObject(t, obj);
        await adapter.query(
          `INSERT INTO ${q(tName)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, values
        );
        inserted.push(obj);
        await this.ctx.restApi._emitChange(projectId, { provider: adapter.provider, id: adapter.connectionId }, tName, 'insert', obj);
      }
      const pkCol = t.pk;
      if (pkCol && inserted.every((o) => o[pkCol] !== undefined)) {
        const placeholders = inserted.map(() => '?').join(', ');
        const fresh = await adapter.query(`SELECT * FROM ${q(tName)} WHERE ${q(pkCol)} IN (${placeholders})`, inserted.map((o) => o[pkCol]));
        const out = [];
        for (const row of fresh.rows) out.push(await this._resolveSelection(adapter, projectId, principal, schema, t, row, sel.selectionSet, fragments, 0));
        return out;
      }
      return inserted;
    }
    if (op.mode === 'update') {
      const set = args.set ?? args.input;
      if (!set || typeof set !== 'object') throw badRequest(`update${gqlName(tName)} needs "set"`);
      const filters = typeof args.where === 'string' ? JSON.parse(args.where || '{}') : (args.where || {});
      if (!Object.keys(filters).length && args.pk === undefined) throw badRequest('update requires a "where" filter or "pk"');
      if (args.pk !== undefined) {
        if (!t.pk) throw badRequest(`Table "${tName}" has no primary key`);
        filters[`${t.pk}.eq`] = args.pk;
      }
      const { cols, values } = columnsFromObject(t, set);
      const { clause, params } = this.ctx.restApi.buildWhere(this.ctx.restApi.parseFilters({ query: filters }, { columns: t.columns }), adapter.provider);
      const result = await adapter.query(
        `UPDATE ${q(tName)} SET ${cols.map((c) => `${q(c)} = ?`).join(', ')} WHERE ${clause || '1=1'}`,
        [...values, ...params]
      );
      return result.rowCount ?? result.changes ?? 0;
    }
    if (op.mode === 'delete') {
      const filters = typeof args.where === 'string' ? JSON.parse(args.where || '{}') : (args.where || {});
      if (args.pk !== undefined) {
        if (!t.pk) throw badRequest(`Table "${tName}" has no primary key`);
        filters[`${t.pk}.eq`] = args.pk;
      }
      if (!Object.keys(filters).length) throw badRequest('delete requires a "where" filter or "pk"');
      const { clause, params } = this.ctx.restApi.buildWhere(this.ctx.restApi.parseFilters({ query: filters }, { columns: t.columns }), adapter.provider);
      const result = await adapter.query(`DELETE FROM ${q(tName)} WHERE ${clause}`, params);
      await this.ctx.restApi._emitChange(projectId, { provider: adapter.provider, id: adapter.connectionId }, tName, 'delete', null);
      return result.rowCount ?? result.changes ?? 0;
    }
    throw badRequest(`Unsupported operation ${op.mode}`);
  }

  async _resolveSelection(adapter, projectId, principal, schema, t, row, selectionSet, fragments, depth) {
    if (depth > 6) return row; // depth guard
    const out = {};
    const fks = schema.fks.get(t.name) || [];
    for (const sel of expandSelections(selectionSet, fragments, t.name)) {
      const alias = sel.alias || sel.name;
      if (sel.name === '__typename') { out[alias] = gqlName(t.name); continue; }
      const col = t.columns.find((c) => c.name === sel.name);
      if (col) {
        const v = row[col.name];
        out[alias] = v instanceof Buffer ? v.toString('utf8') : (v === undefined ? null : v);
        continue;
      }
      const rel = fks.find((f) => f.field === sel.name);
      if (rel) {
        out[alias] = await this._resolveRelation(adapter, projectId, principal, schema, t, row, rel, sel, fragments, depth);
        continue;
      }
      out[alias] = null;
    }
    return out;
  }

  async _resolveRelation(adapter, projectId, principal, schema, t, row, rel, sel, fragments, depth) {
    const target = schema.tables.get(rel.target);
    if (!target) return rel.kind === 'toMany' ? [] : null;
    const q = (id) => adapter.provider === 'mysql' || adapter.provider === 'mariadb' ? '`' + id + '`' : '"' + id + '"';
    if (rel.kind === 'toOne') {
      const policy = this.ctx.policies.sqlWhere(projectId, rel.target, 'select', principal);
      const whereParts = [`${q(rel.remote)} = ?`, policy?.clause].filter(Boolean);
      const result = await adapter.query(`SELECT * FROM ${q(rel.target)} WHERE ${whereParts.join(' AND ')} LIMIT 1`,
        [row[rel.local], ...(policy?.params || [])]);
      if (!result.rows.length) return null;
      return this._resolveSelection(adapter, projectId, principal, schema, target, result.rows[0], sel.selectionSet, fragments, depth + 1);
    }
    const policy = this.ctx.policies.sqlWhere(projectId, rel.target, 'select', principal);
    const whereParts = [`${q(rel.remote)} = ?`, policy?.clause].filter(Boolean);
    const result = await adapter.query(`SELECT * FROM ${q(rel.target)} WHERE ${whereParts.join(' AND ')} LIMIT 100`,
      [row[rel.remote], ...(policy?.params || [])]);
    const out = [];
    for (const r of result.rows) out.push(await this._resolveSelection(adapter, projectId, principal, schema, target, r, sel.selectionSet, fragments, depth + 1));
    return out;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function valueOf(v, vars) {
  switch (v?.kind) {
    case 'Variable': return vars[v.name];
    case 'Literal': case 'EnumValue': return v.value;
    case 'List': return v.values.map((x) => valueOf(x, vars));
    case 'Object': return Object.fromEntries(v.fields.map((f) => [f.name, valueOf(f.value, vars)]));
    default: return null;
  }
}

function argsOf(args, vars) {
  const out = {};
  for (const a of args) out[a.name] = valueOf(a.value, vars);
  return out;
}

function expandSelections(selectionSet, fragments, typeName) {
  const out = [];
  for (const sel of selectionSet.selections) {
    if (sel.kind === 'Field') out.push(sel);
    else if (sel.kind === 'FragmentSpread') {
      const frag = fragments.get(sel.name);
      if (frag && (!frag.typeCondition || frag.typeCondition.toLowerCase() === typeName.toLowerCase())) {
        out.push(...expandSelections(frag.selectionSet, fragments, typeName));
      }
    } else if (sel.kind === 'InlineFragment') {
      if (!sel.typeCondition || sel.typeCondition.toLowerCase() === typeName.toLowerCase()) {
        out.push(...expandSelections(sel.selectionSet, fragments, typeName));
      }
    }
  }
  return out;
}

function resolveFragment(sel, fragments, schema, defaultType) {
  if (sel.kind === 'Field') return [sel];
  if (sel.kind === 'InlineFragment') {
    return expandSelections(sel.selectionSet, fragments, sel.typeCondition || defaultType);
  }
  const frag = fragments.get(sel.name);
  if (!frag) return [];
  return expandSelections(frag.selectionSet, fragments, frag.typeCondition || defaultType);
}

function matchTableOp(schema, fieldName) {
  for (const [name] of schema.tables) {
    const raw = gqlName(name);
    const N = gqlTypeName(name);
    if (fieldName === name || fieldName === raw) return { table: name, kind: 'query', mode: 'list' };
    if (fieldName === `${N}ByPk` || fieldName === `${raw}ByPk`) return { table: name, kind: 'query', mode: 'byPk' };
    if (fieldName === `insert${N}` || fieldName === `insert${raw}`) return { table: name, kind: 'mutation', mode: 'insert' };
    if (fieldName === `update${N}` || fieldName === `update${raw}`) return { table: name, kind: 'mutation', mode: 'update' };
    if (fieldName === `delete${N}` || fieldName === `delete${raw}`) return { table: name, kind: 'mutation', mode: 'delete' };
  }
  return null;
}

function columnsFromObject(t, obj) {
  const cols = [];
  const values = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (!t.columns.some((c) => c.name === k)) continue;
    cols.push(k);
    values.push(v === undefined ? null : (v instanceof Buffer ? v.toString('utf8') : (typeof v === 'object' ? JSON.stringify(v) : v)));
  }
  if (!cols.length) throw badRequest('No valid columns in mutation object');
  return { cols, values };
}

function reqPrincipal(ctx, projectId) {
  // GraphQL runs inside a request guarded by server.js; the current principal
  // is attached right before execution. If somehow absent, deny RLS bypass.
  return ctx.__currentPrincipal || { bypassRls: false, role: 'anon' };
}

export async function register(ctx) {
  ctx.graphql = new GraphqlService(ctx);
}

export function mountRoutes(ctx) {
  ctx.router.post('/api/v1/:projectId/graphql', async (req, res) => {
    ctx.__currentPrincipal = req.principal || null;
    try {
      res.json(200, await ctx.graphql.execute(req));
    } finally {
      ctx.__currentPrincipal = null;
    }
  }, { auth: 'project' });

  // Playground served as a minimal HTML page for quick manual testing
  ctx.router.get('/api/v1/:projectId/graphql/playground', async (req, res) => {
    const projectId = req.params.projectId;
    const html = `<!doctype html><html><head><title>Bloop GraphQL Playground</title>
<style>body{background:#0d0e0f;color:#e7e9ea;font-family:ui-monospace,monospace;margin:0;display:grid;grid-template-rows:1fr auto;height:100vh}
textarea{background:#17181a;color:#e7e9ea;border:1px solid #2a2c2e;border-radius:8px;padding:12px;width:calc(100vw - 32px);height:38vh;margin:8px 16px;resize:vertical}
button{margin:8px 16px;padding:8px 18px;background:#3bf95c;color:#06130a;border:0;border-radius:8px;font-weight:700;cursor:pointer}
pre{margin:8px 16px;padding:12px;background:#17181a;border:1px solid #2a2c2e;border-radius:8px;overflow:auto;flex:1}</style></head>
<body><textarea id="q">query {
  __schema { queryType { name } types { name kind } }
}</textarea>
<button onclick="run()">Run query</button>
<pre id="out">Result…</pre>
<script>
async function run(){
  const r = await fetch('/api/v1/${projectId}/graphql',{method:'POST',headers:{'Content-Type':'application/json','Authorization':localStorage.getItem('bloop_project_key_'+window.location.hash.slice(1))||'Bearer '+ (prompt('Paste API key or user JWT:')||'')},body:JSON.stringify({query:document.getElementById('q').value})});
  document.getElementById('out').textContent = JSON.stringify(await r.json(),null,2);
}
</script></body></html>`;
    res.text(200, html, 'text/html; charset=utf-8');
  }, { auth: 'public' });
}
