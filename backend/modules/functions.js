// modules/functions.js — server-side JavaScript functions executed in an
// isolated Worker thread with a sandboxed vm context (no require, no process,
// no filesystem, no network unless explicitly enabled). Timeout, memory and
// concurrency limits are enforced; every execution is logged.
// IMPORTANT (honesty note): worker+vm provides strong practical isolation for
// a self-hosted platform, but Node.js itself documents vm as "not a security
// mechanism". For hostile multi-tenant code, run functions in a dedicated
// container (see docs/functions.md).
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { badRequest, notFound, tooManyRequests, AppError } from '../core/error-handler.js';
import { validateOrThrow } from '../core/validation.js';

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const timers = [];

function makeConsole(invocationId) {
  const send = (level, args) => {
    try {
      parentPort.postMessage({ type: 'log', level, message: args.map(format).join(' ').slice(0, 4000) });
    } catch { }
  };
  return {
    log: (...a) => send('info', a),
    info: (...a) => send('info', a),
    warn: (...a) => send('warn', a),
    error: (...a) => send('error', a),
    debug: (...a) => send('debug', a),
  };
}
function format(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || String(v);
  try { return JSON.stringify(v, (k, x) => typeof x === 'bigint' ? String(x) : x, 2); } catch { return String(v); }
}

async function run() {
  const { code, event, secrets, env, timeoutMs, allowFetch, invocationId, context } = workerData;
  const console = makeConsole(invocationId);
  const sandbox = {
    console,
    JSON, Math, Date, Number, String, Boolean, Array, Object, Symbol, Map, Set,
    WeakMap, WeakSet, Promise, RegExp, Error, TypeError, RangeError,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    TextEncoder, TextDecoder, URL, URLSearchParams, structuredClone,
    setTimeout: (fn, ms) => { const t = setTimeout(() => { try { fn(); } catch (e) { console.error(e); } }, Math.min(ms || 0, 5000)); timers.push(t); return t; },
    clearTimeout: (t) => { clearTimeout(t); },
    crypto: { randomUUID: () => require('node:crypto').randomUUID(), randomBytes: (n) => require('node:crypto').randomBytes(Math.min(n || 16, 4096)).toString('base64') },
    bloop: {
      invocationId,
      event,
      context,
      secrets: Object.fromEntries((secrets || []).map((s) => [s.key, s.value])),
      env,
      http: allowFetch ? { fetch } : undefined,
    },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  let handler;
  try {
    handler = vm.runInContext(
      '(function(){ "use strict"; ' + code + '\\n; if (typeof handler === "function") return handler; if (typeof exports === "object" && typeof exports.default === "function") return exports.default; throw new Error("Function code must define a handler(req, ctx) function or export default"); })()',
      ctx,
      { timeout: Math.min(timeoutMs, 30000) }
    );
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: 'Syntax/loading error: ' + err.message });
    return;
  }
  if (typeof handler !== 'function') {
    parentPort.postMessage({ type: 'error', message: 'Function code must define a handler(req, ctx) function' });
    return;
  }
  try {
    const result = await Promise.race([
      Promise.resolve(handler(sandbox.bloop.event, sandbox.bloop)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('__BLOOP_TIMEOUT__' + timeoutMs)), timeoutMs)),
    ]);
    parentPort.postMessage({ type: 'result', status: 'ok', body: normalizeResult(result) });
  } catch (err) {
    const isTimeout = String(err?.message || '').startsWith('__BLOOP_TIMEOUT__');
    parentPort.postMessage({ type: isTimeout ? 'timeout' : 'error', message: isTimeout ? ('Function exceeded the ' + timeoutMs + 'ms execution limit') : (err.message || String(err)) });
  } finally {
    for (const t of timers) clearTimeout(t);
  }
}
function normalizeResult(result) {
  if (result === undefined || result === null) return null;
  if (typeof result === 'object' && !(result instanceof Date)) {
    try { return JSON.parse(JSON.stringify(result, (k, x) => typeof x === 'bigint' ? String(x) : x)); } catch { return String(result); }
  }
  return result;
}
run().catch((err) => parentPort.postMessage({ type: 'error', message: err.message }));
`;

const DEFAULT_CODE_SAMPLE = `// Bloop function — runs in an isolated worker with a sandboxed vm context.
// Define an async handler(req, ctx). ctx.secrets / ctx.env are injected.
async function handler(req, ctx) {
  return {
    message: 'Hello from Bloop Functions!',
    received: req.body ?? null,
    query: req.query ?? null,
    time: new Date().toISOString(),
  };
}`;

export class FunctionsService {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'functions' });
    this.concurrency = new Map(); // projectId -> running count
    this.busUnsubs = [];
  }

  get db() { return this.ctx.system; }

  // ── CRUD ──────────────────────────────────────────────────────────────────
  create(projectId, input) {
    const data = validateOrThrow({
      slug: { type: 'string', required: true, min: 1, max: 64, pattern: '^[a-z0-9][a-z0-9-]*$' },
      name: { type: 'string', default: '' },
      code: { type: 'string', required: true, max: 512 * 1024 },
      timeoutMs: { type: 'integer', default: 10000, min: 100, max: 60000 },
      secrets: { type: 'array', default: [] },
      triggers: { type: 'array', default: [] },
      enabled: { type: 'boolean', default: true },
    }, input);
    // syntactic sanity check (compiles the code without executing it)
    try { new Function(data.code); } catch (err) {
      throw badRequest(`Function code does not compile: ${err.message}`);
    }
    const existing = this.db.get('SELECT id FROM functions WHERE project_id = ? AND slug = ?', [projectId, data.slug]);
    if (existing) throw badRequest(`Function slug "${data.slug}" already exists in this project`);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const secretsEnc = JSON.stringify((data.secrets || []).map((s) => ({ key: s.key, value: this.ctx.security.encrypt(String(s.value)) })));
    this.db.run(
      'INSERT INTO functions (id, project_id, slug, name, code, enabled, timeout_ms, secrets_json, triggers_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id, projectId, data.slug, data.name || data.slug, data.code, data.enabled ? 1 : 0, data.timeoutMs, secretsEnc, JSON.stringify(data.triggers || []), now, now]
    );
    this.ctx.audit?.record({ actor: 'system', action: 'function.create', projectId, target: data.slug });
    this._registerTriggers(projectId, id);
    return this.get(projectId, id);
  }

  update(projectId, fnId, patch) {
    const fn = this.get(projectId, fnId);
    const data = validateOrThrow({
      code: { type: 'string', max: 512 * 1024 },
      name: { type: 'string', max: 100 },
      timeoutMs: { type: 'integer', min: 100, max: 60000 },
      enabled: { type: 'boolean' },
      secrets: { type: 'array' },
      triggers: { type: 'array' },
    }, patch);
    if (data.code !== undefined) {
      try { new Function(data.code); } catch (err) { throw badRequest(`Function code does not compile: ${err.message}`); }
      this.db.run('UPDATE functions SET code = ? WHERE id = ?', [data.code, fn.id]);
    }
    if (data.name !== undefined) this.db.run('UPDATE functions SET name = ? WHERE id = ?', [data.name, fn.id]);
    if (data.timeoutMs !== undefined) this.db.run('UPDATE functions SET timeout_ms = ? WHERE id = ?', [data.timeoutMs, fn.id]);
    if (data.enabled !== undefined) this.db.run('UPDATE functions SET enabled = ? WHERE id = ?', [data.enabled ? 1 : 0, fn.id]);
    if (data.secrets !== undefined) {
      this.db.run('UPDATE functions SET secrets_json = ? WHERE id = ?',
        [JSON.stringify(data.secrets.map((s) => ({ key: s.key, value: this.ctx.security.encrypt(String(s.value)) }))), fn.id]);
    }
    if (data.triggers !== undefined) this.db.run('UPDATE functions SET triggers_json = ? WHERE id = ?', [JSON.stringify(data.triggers), fn.id]);
    this.db.run('UPDATE functions SET updated_at = ? WHERE id = ?', [new Date().toISOString(), fn.id]);
    this._registerTriggers(projectId, fn.id);
    return this.get(projectId, fnId);
  }

  list(projectId) {
    return this.db.all('SELECT id, project_id, slug, name, enabled, timeout_ms, triggers_json, LENGTH(code) AS code_size, created_at, updated_at FROM functions WHERE project_id = ? ORDER BY created_at', [projectId])
      .map((f) => ({ ...f, triggers: JSON.parse(f.triggers_json || '[]'), triggers_json: undefined }));
  }

  get(projectId, fnIdOrSlug) {
    const fn = this.db.get('SELECT * FROM functions WHERE project_id = ? AND (id = ? OR slug = ?)', [projectId, fnIdOrSlug, fnIdOrSlug]);
    if (!fn) throw notFound('Function not found');
    return {
      ...fn,
      secrets: JSON.parse(fn.secrets_json || '[]').map((s) => ({ key: s.key, value: '••••••••' })),
      triggers: JSON.parse(fn.triggers_json || '[]'),
      secrets_json: undefined,
    };
  }

  delete(projectId, fnId) {
    const fn = this.get(projectId, fnId);
    this.db.run('DELETE FROM functions WHERE id = ?', [fn.id]);
    this.db.run('DELETE FROM custom_endpoints WHERE function_id = ?', [fn.id]);
    this.db.run('DELETE FROM function_logs WHERE function_id = ?', [fn.id]);
    this.db.run('DELETE FROM function_executions WHERE function_id = ?', [fn.id]);
    return { deleted: true };
  }

  setSecrets(projectId, fnId, secrets) {
    const fn = this.get(projectId, fnId);
    if (!Array.isArray(secrets)) throw badRequest('secrets must be an array of {key, value}');
    this.db.run('UPDATE functions SET secrets_json = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(secrets.map((s) => ({ key: String(s.key), value: this.ctx.security.encrypt(String(s.value)) }))), new Date().toISOString(), fn.id]);
    return { updated: secrets.length };
  }

  // ── Execution ─────────────────────────────────────────────────────────────
  async invoke(projectId, fnIdOrSlug, { trigger = 'manual', event = {}, req = null, logInvocation = true } = {}) {
    const fn = this.db.get('SELECT * FROM functions WHERE project_id = ? AND (id = ? OR slug = ?)', [projectId, fnIdOrSlug, fnIdOrSlug]);
    if (!fn) throw notFound('Function not found');
    if (!fn.enabled) throw badRequest(`Function "${fn.slug}" is disabled`);
    const maxConcurrent = this.ctx.config.get('functions.maxConcurrentPerProject', 5);
    const running = this.concurrency.get(projectId) || 0;
    if (running >= maxConcurrent) {
      throw tooManyRequests(`Function concurrency limit (${maxConcurrent}) reached for this project`);
    }
    const timeoutMs = Math.min(fn.timeout_ms || 10000, this.ctx.config.get('functions.maxTimeoutMs', 60000));
    const invocationId = crypto.randomUUID();
    const started = Date.now();
    this.concurrency.set(projectId, running + 1);
    const logs = [];
    try {
      const secrets = JSON.parse(fn.secrets_json || '[]').map((s) => {
        try { return { key: s.key, value: this.ctx.security.decrypt(s.value) }; } catch { return { key: s.key, value: '' }; }
      });
      const envVars = await this.ctx.environments?.resolveVars?.(projectId, null) || {};
      const result = await new Promise((resolve) => {
        let worker;
        try {
          worker = new Worker(WORKER_SRC, {
            eval: true,
            workerData: {
              code: fn.code,
              event: event || {},
              secrets,
              env: { ...envVars, BLOOP_PROJECT: projectId, BLOOP_FUNCTION: fn.slug, BLOOP_INVOCATION: invocationId },
              timeoutMs,
              allowFetch: this.ctx.config.get('functions.allowFetch', false),
              invocationId,
              context: { trigger, projectId },
            },
            resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, codeRangeSizeMb: 16 },
            stdout: false,
            stderr: false,
          });
        } catch (err) {
          return resolve({ status: 'error', error: `Failed to spawn function worker: ${err.message}`, logs });
        }
        const timer = setTimeout(() => {
          worker.terminate();
          resolve({ status: 'timeout', error: `Function exceeded the ${timeoutMs}ms timeout and was terminated`, logs });
        }, timeoutMs + 1000);
        worker.on('message', (msg) => {
          if (msg.type === 'log') logs.push({ level: msg.level, message: msg.message, ts: new Date().toISOString() });
          else if (msg.type === 'result') { clearTimeout(timer); resolve({ status: 'ok', body: msg.body, logs }); }
          else if (msg.type === 'timeout') { clearTimeout(timer); worker.terminate(); resolve({ status: 'timeout', error: msg.message, logs }); }
          else if (msg.type === 'error') { clearTimeout(timer); resolve({ status: 'error', error: msg.message, logs }); }
        });
        worker.on('error', (err) => { clearTimeout(timer); resolve({ status: 'error', error: err.message, logs }); });
        worker.on('exit', (code) => {
          clearTimeout(timer);
          if (code !== 0) resolve({ status: 'error', error: `Worker exited with code ${code}`, logs });
        });
      });
      const durationMs = Date.now() - started;
      if (logInvocation) {
        this._recordExecution(projectId, fn.id, trigger, result.status, durationMs, result.error, logs);
      }
      this.ctx.tracing?.addSpan?.(`function:${fn.slug}`, 'function', durationMs, result.status);
      this.ctx.metrics?.increment?.(`function_executions_total{status="${result.status}"}`);
      return { ...result, invocationId, durationMs, functionId: fn.id, slug: fn.slug };
    } finally {
      this.concurrency.set(projectId, Math.max(0, (this.concurrency.get(projectId) || 1) - 1));
    }
  }

  _recordExecution(projectId, fnId, trigger, status, durationMs, error, logs) {
    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.db.run('INSERT INTO function_executions (id, project_id, function_id, trigger, status, duration_ms, error, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [id, projectId, fnId, trigger, status, durationMs, error || null, now]);
      let seq = 0;
      for (const l of (logs || []).slice(0, 200)) {
        this.db.run('INSERT INTO function_logs (project_id, function_id, invocation_id, level, message, created_at) VALUES (?,?,?,?,?,?)',
          [projectId, fnId, id, l.level, l.message, l.ts || now]);
        seq++;
      }
      // log retention: keep the newest 5000 rows
      this.db.exec('DELETE FROM function_logs WHERE id NOT IN (SELECT id FROM function_logs ORDER BY id DESC LIMIT 5000)');
      this.db.run('DELETE FROM function_executions WHERE created_at < ?', [new Date(Date.now() - 90 * 86400_000).toISOString()]);
    } catch (err) {
      this.log.debug(`failed to record execution: ${err.message}`);
    }
  }

  logs(projectId, fnId, { limit = 200 } = {}) {
    const fn = this.get(projectId, fnId);
    return {
      executions: this.db.all('SELECT * FROM function_executions WHERE function_id = ? ORDER BY created_at DESC LIMIT ?', [fn.id, limit]),
      logs: this.db.all('SELECT * FROM function_logs WHERE function_id = ? ORDER BY id DESC LIMIT ?', [fn.id, limit]),
    };
  }

  clearLogs(projectId, fnId) {
    const fn = this.get(projectId, fnId);
    this.db.run('DELETE FROM function_logs WHERE function_id = ?', [fn.id]);
    this.db.run('DELETE FROM function_executions WHERE function_id = ?', [fn.id]);
    return { cleared: true };
  }

  // ── Event triggers ────────────────────────────────────────────────────────
  _registerTriggers(projectId, fnId) {
    const fn = this.db.get('SELECT * FROM functions WHERE id = ?', [fnId]);
    if (!fn) return;
    this.busUnsubs = this.busUnsubs.filter((u) => u.fnId !== fnId);
    const triggers = JSON.parse(fn.triggers_json || '[]');
    for (const t of triggers) {
      if (t.type !== 'database') continue;
      const off = this.ctx.bus.on(`db.${t.op || 'change'}`, async (evt) => {
        if (evt.projectId !== projectId) return;
        if (t.table && evt.table !== t.table) return;
        try {
          await this.invoke(projectId, fnId, {
            trigger: `db:${evt.op}:${evt.table}`,
            event: { table: evt.table, op: evt.op, before: evt.before ?? null, after: evt.after ?? null },
          });
        } catch (err) {
          this.log.warn(`event-triggered function ${fn.slug} failed: ${err.message}`);
        }
      });
      this.busUnsubs.push({ fnId, off });
    }
  }

  // ── Custom endpoints ──────────────────────────────────────────────────────
  createEndpoint(projectId, { path, method = 'POST', functionId, authRequired = false }) {
    if (!/^[a-z0-9][a-z0-9/_-]*$/i.test(path)) throw badRequest('Endpoint path must be alphanumeric (slashes, dashes allowed)');
    const fn = this.db.get('SELECT * FROM functions WHERE id = ? AND project_id = ?', [functionId, projectId]);
    if (!fn) throw notFound('Function not found');
    const id = crypto.randomUUID();
    this.db.run('INSERT INTO custom_endpoints (id, project_id, path, method, function_id, auth_required, enabled, created_at) VALUES (?,?,?,?,?,?,1,?)',
      [id, projectId, path, method.toUpperCase(), functionId, authRequired ? 1 : 0, new Date().toISOString()]);
    return this.db.get('SELECT * FROM custom_endpoints WHERE id = ?', [id]);
  }

  listEndpoints(projectId) {
    return this.db.all(
      `SELECT ce.*, f.slug AS function_slug FROM custom_endpoints ce
       LEFT JOIN functions f ON f.id = ce.function_id WHERE ce.project_id = ? ORDER BY ce.created_at`, [projectId]
    );
  }

  deleteEndpoint(projectId, epId) {
    const ep = this.db.get('SELECT * FROM custom_endpoints WHERE id = ? AND project_id = ?', [epId, projectId]);
    if (!ep) throw notFound('Endpoint not found');
    this.db.run('DELETE FROM custom_endpoints WHERE id = ?', [epId]);
    return { deleted: true };
  }
}

export async function register(ctx) {
  ctx.functions = new FunctionsService(ctx);
}

export function mountRoutes(ctx) {
  const F = () => ctx.functions;

  ctx.router.post('/api/v1/:projectId/functions/:slug', async (req, res) => {
    ctx.authorization.scopeCheck(req.principal, 'functions', 'invoke');
    const result = await F().invoke(req.params.projectId, req.params.slug, {
      trigger: 'http',
      event: { method: req.method, query: req.query, body: req.body ?? null, headers: { 'content-type': req.headers['content-type'] || null }, principal: { userId: req.principal.userId, role: req.principal.role } },
      req,
    });
    res.json(result.status === 'ok' ? 200 : 500, result);
  }, { auth: 'project' });

  ctx.router.get('/api/v1/:projectId/functions/:slug', async (req, res) => {
    ctx.authorization.scopeCheck(req.principal, 'functions', 'invoke');
    const result = await F().invoke(req.params.projectId, req.params.slug, {
      trigger: 'http',
      event: { method: 'GET', query: req.query, body: null, principal: { userId: req.principal.userId, role: req.principal.role } },
      req,
    });
    res.json(result.status === 'ok' ? 200 : 500, result);
  }, { auth: 'project' });
}
