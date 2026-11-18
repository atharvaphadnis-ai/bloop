// core/policy-engine.js — row-level security.
// Policies are per project/table/command expressions such as:
//   "user_id == auth.uid()"            (owner-only rows)
//   "auth.role() == 'service'"         (service-role only)
//   "public == true or auth.uid() == owner_id"
// The expression compiler is a small recursive-descent parser — never eval() —
// producing an AST that can both filter rows in JS and translate to a
// parameterized SQL WHERE clause (no string concatenation of values).
import { badRequest } from './error-handler.js';

// ── Tokenizer ────────────────────────────────────────────────────────────────
const OPERATORS = ['==', '!=', '>=', '<=', '=',
  '&&', '||', 'and', 'or', 'not', 'in', 'contains',
  '>', '<', '!', '(', ')', ',', '+', '-', '*'];

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_@.$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_@.$]/.test(src[j])) j++;
      tokens.push({ type: 'ident', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9.eE]/.test(src[j])) j++;
      tokens.push({ type: 'number', value: parseFloat(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') { j++; out += src[j] ?? ''; }
        else out += src[j];
        j++;
      }
      if (j >= src.length) throw badRequest(`policy: unterminated string near position ${i}`);
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    let matched = null;
    for (const op of OPERATORS) {
      if (src.startsWith(op, i)) { matched = op; break; }
    }
    if (!matched) throw badRequest(`policy: unexpected character "${c}" at position ${i}`);
    tokens.push({ type: 'op', value: matched });
    i += matched.length;
  }
  return tokens;
}

// ── Parser → AST ─────────────────────────────────────────────────────────────
function parseExpr(src) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isKw = (v) => peek() && peek().type === 'op' && peek().value.toLowerCase() === v;

  function parseOr() {
    let left = parseAnd();
    while (isKw('or') || (peek()?.type === 'op' && peek().value === '||')) {
      pos++;
      left = { kind: 'or', left, right: parseAnd() };
    }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (isKw('and') || (peek()?.type === 'op' && peek().value === '&&')) {
      pos++;
      left = { kind: 'and', left, right: parseNot() };
    }
    return left;
  }
  function parseNot() {
    if (isKw('not') || (peek()?.type === 'op' && peek().value === '!')) {
      pos++;
      return { kind: 'not', expr: parseNot() };
    }
    return parseComparison();
  }
  function parseComparison() {
    let left = parsePrimary();
    while (peek()) {
      const t = peek();
      if (t.type === 'op' && ['==', '=', '!=', '>', '<', '>=', '<=', 'contains', 'in'].includes(t.value.toLowerCase())) {
        const opRaw = t.value.toLowerCase();
        pos++;
        const op = opRaw === '=' ? '==' : opRaw;
        const right = parsePrimary();
        left = { kind: 'cmp', op, left, right };
      } else break;
    }
    return left;
  }
  function parsePrimary() {
    const t = peek();
    if (!t) throw badRequest('policy: unexpected end of expression');
    if (t.type === 'op' && t.value === '(') {
      pos++;
      const e = parseOr();
      if (!peek() || peek().value !== ')') throw badRequest('policy: missing closing parenthesis');
      pos++;
      return e;
    }
    if (t.type === 'number') { pos++; return { kind: 'lit', value: t.value }; }
    if (t.type === 'string') { pos++; return { kind: 'lit', value: t.value }; }
    if (t.type === 'ident') {
      pos++;
      const name = t.value;
      if (name === 'true') return { kind: 'lit', value: true };
      if (name === 'false') return { kind: 'lit', value: false };
      if (name === 'null') return { kind: 'lit', value: null };
      if (name.startsWith('auth.')) {
        const node = parseAuth(name);
        // support call syntax: auth.uid() / auth.role()
        if (peek() && peek().type === 'op' && peek().value === '(') {
          pos++;
          if (!peek() || peek().value !== ')') throw badRequest('policy: expected ")" after ' + name);
          pos++;
        }
        return node;
      }
      // column reference (row field)
      const field = name.startsWith('row.') ? name.slice(4) : name;
      return { kind: 'col', name: field };
    }
    throw badRequest(`policy: unexpected token "${t.value}"`);
  }
  function parseAuth(name) {
    const parts = name.split('.');
    if (parts[1] === 'uid' || parts[1] === 'role') return { kind: 'auth', fn: parts[1] };
    if (parts[1] === 'jwt' && parts[2]) return { kind: 'authClaim', claim: parts.slice(2).join('.') };
    throw badRequest(`policy: unsupported auth function "${name}" (supported: auth.uid(), auth.role(), auth.jwt.claim.X)`);
  }
  const ast = parseOr();
  if (pos < tokens.length) throw badRequest(`policy: unexpected trailing token "${tokens[pos].value}"`);
  return ast;
}

// ── Evaluator (JS, per-row) ──────────────────────────────────────────────────
function evalAst(ast, row, auth) {
  switch (ast.kind) {
    case 'lit': return ast.value;
    case 'col': return row ? row[ast.name] : undefined;
    case 'auth': return ast.fn === 'uid' ? auth.uid : auth.role;
    case 'authClaim': return auth.claims?.[ast.claim];
    case 'not': return !truthy(evalAst(ast.expr, row, auth));
    case 'and': return truthy(evalAst(ast.left, row, auth)) && truthy(evalAst(ast.right, row, auth));
    case 'or': return truthy(evalAst(ast.left, row, auth)) || truthy(evalAst(ast.right, row, auth));
    case 'cmp': {
      const l = evalAst(ast.left, row, auth);
      const r = evalAst(ast.right, row, auth);
      switch (ast.op) {
        case '==': return l == r; // eslint-disable-line eqeqeq — policy comparisons are intentionally loose
        case '!=': return l != r; // eslint-disable-line eqeqeq
        case '>': return l > r;
        case '<': return l < r;
        case '>=': return l >= r;
        case '<=': return l <= r;
        case 'contains': return typeof l === 'string' && typeof r === 'string' && l.includes(r);
        case 'in': return Array.isArray(r) ? r.includes(l) : false;
        default: throw badRequest(`policy: unknown operator ${ast.op}`);
      }
    }
    default: throw badRequest('policy: malformed expression');
  }
}
const truthy = (v) => !!v;

// ── SQL translation (parameterized — values become bind parameters) ─────────
function astToSql(ast, params) {
  switch (ast.kind) {
    case 'lit': params.push(ast.value); return '?';
    case 'col': return quoteIdent(ast.name);
    case 'auth':
      params.push(authPlaceholder(ast.fn));
      return '?';
    case 'authClaim': params.push(null); return '?'; // resolved per-request at execution time
    case 'not': return `(NOT (${astToSql(ast.expr, params)}))`;
    case 'and': return `(${astToSql(ast.left, params)} AND ${astToSql(ast.right, params)})`;
    case 'or': return `(${astToSql(ast.left, params)} OR ${astToSql(ast.right, params)})`;
    case 'cmp': {
      const l = astToSql(ast.left, params);
      const r = astToSql(ast.right, params);
      const op = ast.op === 'contains' ? 'LIKE' : ast.op === 'in' ? 'IN' : ast.op === '!=' ? '<>' : ast.op;
      return `(${l} ${op} ${r})`;
    }
    default: throw badRequest('policy: cannot translate expression');
  }
}
function authPlaceholder(kind) { return `__auth_${kind}__`; }
function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw badRequest(`policy: invalid column name "${name}"`);
  return `"${name}"`;
}

export class PolicyEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.cache = new Map(); // projectId -> [{table, command, ast, roles, name, enabled}]
  }

  invalidate(projectId) {
    if (projectId) this.cache.delete(projectId);
    else this.cache.clear();
  }

  policiesFor(projectId, table) {
    let all = this.cache.get(projectId);
    if (!all) {
      const rows = this.ctx.system.all('SELECT * FROM row_policies WHERE project_id = ? AND enabled = 1', [projectId]);
      all = rows.map((r) => ({ ...r, ast: parseExpr(r.expression) }));
      this.cache.set(projectId, all);
    }
    return table ? all.filter((p) => p.table === table) : all;
  }

  add(projectId, { table, name, command = 'all', expression, roles = ['authenticated'], enabled = true }) {
    // validate the expression compiles before storing
    const ast = parseExpr(expression);
    const id = crypto.randomUUID();
    this.ctx.system.run(
      'INSERT INTO row_policies (id, project_id, table_name, policy_name, command, expression, roles, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, projectId, table, name, command, expression, JSON.stringify(roles), enabled ? 1 : 0, new Date().toISOString()]
    );
    this.invalidate(projectId);
    return this.ctx.system.get('SELECT * FROM row_policies WHERE id = ?', [id]);
  }

  remove(projectId, policyId) {
    const p = this.ctx.system.get('SELECT id FROM row_policies WHERE id = ? AND project_id = ?', [policyId, projectId]);
    if (!p) throw badRequest('Policy not found');
    this.ctx.system.run('DELETE FROM row_policies WHERE id = ?', [policyId]);
    this.invalidate(projectId);
    return { deleted: true };
  }

  list(projectId) {
    return this.ctx.system.all('SELECT * FROM row_policies WHERE project_id = ? ORDER BY created_at', [projectId]);
  }

  applicable(projectId, table, command, principal) {
    const cmds = [command, 'all'];
    return this.policiesFor(projectId, table).filter((p) => cmds.includes(p.command));
  }

  /**
   * Filter rows for a principal. Service keys, dashboard admins and projects
   * without policies bypass filtering (documented least-privilege behavior:
   * anonymous/authenticated users get policy-gated access).
   */
  filterRows(projectId, table, rows, principal) {
    const role = principal?.role || 'anon';
    if (principal?.bypassRls) return rows;
    const policies = this.applicable(projectId, table, 'select', principal);
    if (!policies.length) {
      if (role === 'anon' || role === 'authenticated') return []; // default deny
      return rows;
    }
    const auth = { uid: principal.userId, role, claims: principal.claims };
    return rows.filter((row) => {
      return policies.some((p) => {
        if (p.roles && !p.roles.includes(role) && !p.roles.includes('all')) return false;
        try { return truthy(evalAst(p.ast, row, auth)); } catch { return false; }
      });
    });
  }

  /**
   * Build a parameterized WHERE fragment for SQL adapters. Returns
   * { clause, params, auth } — the adapter must bind auth values in place of
   * the __auth_*__ placeholders.
   */
  sqlWhere(projectId, table, command, principal) {
    if (principal?.bypassRls) return null;
    const policies = this.applicable(projectId, table, command, principal);
    if (!policies.length) return null;
    const role = principal?.role || 'anon';
    const combined = policies
      .filter((p) => !p.roles || p.roles.includes(role) || p.roles.includes('all'))
      .map((p) => p.ast);
    if (!combined.length) return null;
    const params = [];
    const clauses = combined.map((ast) => astToSql(ast, params));
    const clause = clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`;
    const auth = { uid: principal.userId, role, claims: principal.claims };
    const resolved = params.map((v) => (v === authPlaceholder('uid') ? (principal.userId ?? null) : v === authPlaceholder('role') ? role : v));
    return { clause, params: resolved, auth };
  }

  /**
   * Check whether a row passes INSERT/UPDATE/DELETE policies (per-row check).
   */
  checkRow(projectId, table, command, row, principal) {
    if (principal?.bypassRls) return true;
    const policies = this.applicable(projectId, table, command, principal);
    if (!policies.length) return principal?.role === 'anon' || principal?.role === 'authenticated' ? false : true;
    const auth = { uid: principal.userId, role: principal.role, claims: principal.claims };
    return policies.some((p) => {
      if (p.roles && !p.roles.includes(principal.role) && !p.roles.includes('all')) return false;
      try { return truthy(evalAst(p.ast, command === 'insert' ? row : (row.after ?? row), auth)); } catch { return false; }
    });
  }

  validateExpression(expression) {
    try {
      parseExpr(expression);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

import crypto from 'node:crypto';
