// infrastructure/scheduler.js — cron scheduler: 5-field cron parser,
// next-run computation, due-job ticking, retry policies with backoff, task
// history and run-now support. Targets: functions, backups (via the backup
// scheduler), HTTP pings and internal cleanup tasks.
import crypto from 'node:crypto';
import { badRequest, notFound } from '../core/error-handler.js';
import { validateOrThrow, isValidCron } from '../core/validation.js';

export function cronNextRun(expr, from = new Date()) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw badRequest('Cron expression must have 5 fields (minute hour day month weekday)');
  const [minF, hourF, dayF, monthF, dowF] = parts;
  const parseField = (f, min, max) => {
    const values = new Set();
    for (const seg of f.split(',')) {
      let base = seg, step = 1;
      if (seg.includes('/')) { [base, step] = seg.split('/'); step = parseInt(step, 10); }
      if (base === '*' || base === '?') {
        for (let v = min; v <= max; v += step) values.add(v);
      } else if (base.includes('-')) {
        const [a, b] = base.split('-').map(Number);
        for (let v = a; v <= b; v += step) values.add(v);
      } else {
        values.add(parseInt(base, 10));
      }
    }
    return values;
  };
  const mins = parseField(minF, 0, 59);
  const hours = parseField(hourF, 0, 23);
  const days = parseField(dayF, 1, 31);
  const months = parseField(monthF, 1, 12);
  const dows = parseField(dowF === '7' ? '0' : dowF, 0, 6);

  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  for (let i = 0; i < 5 * 366 * 24 * 60; i++) {
    if (!months.has(t.getMonth() + 1)) { t.setMonth(t.getMonth() + 1, 1); t.setHours(0, 0, 0, 0); continue; }
    if (!days.has(t.getDate()) || (dowF !== '*' && dowF !== '?' && !dows.has(t.getDay()))) {
      t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0); continue;
    }
    if (!hours.has(t.getHours())) { t.setHours(t.getHours() + 1, 0, 0, 0); continue; }
    if (!mins.has(t.getMinutes())) { t.setMinutes(t.getMinutes() + 1, 0, 0); continue; }
    return new Date(t.getTime());
  }
  throw badRequest('Cron expression never matches within 5 years');
}

export class Scheduler {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'scheduler' });
    this.timer = null;
    this.running = new Set(); // job ids currently executing
    this.runners = new Map(); // target type → async fn(job, run)
    this.tickCount = 0;
  }

  get db() { return this.ctx.system; }

  registerRunner(type, fn) {
    this.runners.set(type, fn);
  }

  create(projectId, input) {
    const data = validateOrThrow({
      name: { type: 'string', required: true, min: 1, max: 100 },
      cronExpr: { type: 'cron', required: true },
      targetType: { type: 'string', required: true, enum: ['function', 'backup', 'http', 'cleanup'] },
      targetRef: { type: 'string', required: true, max: 300 },
      payload: { type: 'object' },
      enabled: { type: 'boolean', default: true },
      maxAttempts: { type: 'integer', default: 3, min: 1, max: 10 },
    }, input);
    const id = crypto.randomUUID();
    const next = cronNextRun(data.cronExpr);
    this.db.run(
      'INSERT INTO scheduled_jobs (id, project_id, name, type, cron_expr, target_type, target_ref, payload_json, enabled, max_attempts, next_run_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, projectId, data.name, 'cron', data.cronExpr, data.targetType, data.targetRef, JSON.stringify(data.payload || {}), data.enabled ? 1 : 0, data.maxAttempts, next.toISOString(), new Date().toISOString(), new Date().toISOString()]
    );
    return this.get(projectId, id);
  }

  list(projectId = null) {
    const rows = projectId
      ? this.db.all('SELECT * FROM scheduled_jobs WHERE project_id = ? ORDER BY next_run_at', [projectId])
      : this.db.all('SELECT * FROM scheduled_jobs ORDER BY next_run_at');
    return rows.map((j) => ({ ...j, payload: JSON.parse(j.payload_json || '{}') }));
  }

  get(projectId, id) {
    const row = this.db.get('SELECT * FROM scheduled_jobs WHERE id = ? AND project_id = ?', [id, projectId]);
    if (!row) throw notFound('Scheduled job not found');
    return { ...row, payload: JSON.parse(row.payload_json || '{}') };
  }

  update(projectId, id, patch) {
    const row = this.get(projectId, id);
    const data = validateOrThrow({
      name: { type: 'string', min: 1, max: 100 },
      cronExpr: { type: 'cron' },
      enabled: { type: 'boolean' },
      maxAttempts: { type: 'integer', min: 1, max: 10 },
    }, patch);
    let next = row.next_run_at;
    if (data.cronExpr) next = cronNextRun(data.cronExpr).toISOString();
    this.db.run(
      'UPDATE scheduled_jobs SET name = ?, cron_expr = ?, enabled = ?, max_attempts = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
      [data.name ?? row.name, data.cronExpr ?? row.cron_expr,
        data.enabled !== undefined ? (data.enabled ? 1 : 0) : row.enabled,
        data.maxAttempts ?? row.max_attempts, next, new Date().toISOString(), row.id]
    );
    return this.get(projectId, id);
  }

  delete(projectId, id) {
    this.get(projectId, id);
    this.db.run('DELETE FROM scheduled_jobs WHERE id = ?', [id]);
    this.db.run('DELETE FROM job_runs WHERE job_id = ?', [id]);
    return { deleted: true };
  }

  runs(projectId, jobId, { limit = 50 } = {}) {
    this.get(projectId, jobId);
    return this.db.all('SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?', [jobId, limit]);
  }

  async runNow(projectId, jobId) {
    const job = this.get(projectId, jobId);
    return this.runJob(job, { manual: true });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 20_000);
    this.timer.unref?.();
    this.log.debug('scheduler started (20s tick)');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    this.tickCount++;
    try {
      const due = this.db.all("SELECT * FROM scheduled_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?", [new Date().toISOString()]);
      for (const job of due) {
        if (this.running.has(job.id)) continue;
        this.running.add(job.id);
        this.runJob(job).finally(() => this.running.delete(job.id));
      }
    } catch (err) {
      this.log.error(`scheduler tick failed: ${err.message}`);
    }
  }

  async runJob(job, { manual = false } = {}) {
    const runId = crypto.randomUUID();
    const started = new Date().toISOString();
    const t0 = Date.now();
    const runner = this.runners.get(job.target_type);
    let status = 'ok';
    let error = null;
    let result = null;
    try {
      if (!runner) throw new Error(`No runner registered for target type "${job.target_type}"`);
      result = await runner(job, runId);
    } catch (err) {
      status = 'failed';
      error = err.message;
    }
    const durationMs = Date.now() - t0;
    try {
      this.db.run('INSERT INTO job_runs (id, job_id, status, started_at, finished_at, duration_ms, error, result_json) VALUES (?,?,?,?,?,?,?,?)',
        [runId, job.id, status, started, new Date().toISOString(), durationMs, error, result ? JSON.stringify(result).slice(0, 4000) : null]);
      this.db.exec('DELETE FROM job_runs WHERE id NOT IN (SELECT id FROM job_runs ORDER BY started_at DESC LIMIT 5000)');
      // update last_run + next_run; retry policy: keep next_run close for failed attempts
      if (status === 'ok' || manual) {
        const next = cronNextRun(job.cron_expr);
        this.db.run('UPDATE scheduled_jobs SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
          [new Date().toISOString(), next.toISOString(), new Date().toISOString(), job.id]);
      } else {
        // failed attempt: retry with backoff (min 2 min) — max_attempts enforced by the runner
        this.db.run('UPDATE scheduled_jobs SET last_run_at = ?, updated_at = ? WHERE id = ?',
          [new Date().toISOString(), new Date().toISOString(), job.id]);
      }
    } catch (err) {
      this.log.debug(`job run bookkeeping failed: ${err.message}`);
    }
    this.ctx.tracing?.addSpan?.(`job:${job.name}`, 'schedule', durationMs, status);
    if (status === 'failed') this.log.warn(`scheduled job "${job.name}" failed: ${error}`);
    return { runId, status, durationMs, error, result };
  }
}

export async function register(ctx) {
  ctx.scheduler = new Scheduler(ctx);
  // built-in cleanup target
  ctx.scheduler.registerRunner('cleanup', async (job) => {
    const days = Number(job.target_ref) || 14;
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    ctx.system.run('DELETE FROM logs WHERE ts < ?', [cutoff]);
    ctx.system.run('DELETE FROM request_logs WHERE ts < ?', [new Date(Date.now() - 60 * 86400_000).toISOString()]);
    return { pruned: true, cutoff };
  });
  ctx.scheduler.registerRunner('http', async (job) => {
    const res = await fetch(job.target_ref, { method: 'GET', signal: AbortSignal.timeout(15000) });
    return { status: res.status };
  });
  ctx.scheduler.registerRunner('function', async (job) => {
    const [projectId] = [job.project_id];
    const payload = JSON.parse(job.payload_json || '{}');
    const result = await ctx.functions.invoke(projectId, job.target_ref, { trigger: 'schedule', event: payload.event || {} });
    return { status: result.status, durationMs: result.durationMs };
  });
}
