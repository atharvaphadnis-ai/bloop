// infrastructure/observability.js — log persistence + search, request-log
// recording, retention pruning and the aggregated health/status summary the
// dashboard Overview page consumes.
export class ObservabilityService {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'observability' });
    this.logQueue = [];
    this.requestQueue = [];
    this.flushTimer = null;
    this.retentionTimer = null;
  }

  get db() { return this.ctx.system; }

  start() {
    // batch-persist logs every 2 seconds (keeps logging cheap)
    this.flushTimer = setInterval(() => this.flush(), 2000);
    this.flushTimer.unref?.();
    // retention sweep every hour
    this.retentionTimer = setInterval(() => this.prune(), 3600_000);
    this.retentionTimer.unref?.();
    // also prune once shortly after boot
    setTimeout(() => this.prune(), 30_000).unref?.();
  }

  recordLog(entry) {
    // entry comes from the logger's onLog hook
    if (!entry) return;
    this.logQueue.push({
      ts: entry.ts || new Date().toISOString(),
      level: entry.level || 'info',
      source: entry.source || entry.ctx || null,
      message: String(entry.msg || '').slice(0, 4000),
      meta: entry.meta ? JSON.stringify(this.ctx.security.redact(entry.meta)).slice(0, 4000) : null,
      project_id: entry.projectId || null,
      request_id: entry.requestId || null,
    });
    if (this.logQueue.length > 5000) this.flush();
  }

  recordRequestLog(req, res, durationMs) {
    if (!this.ctx.config.get('observability.requestLog', true)) return;
    this.requestQueue.push({
      ts: new Date().toISOString(),
      project_id: req.project?.id || (req.principal?.projectId ?? null) || (req.params?.projectId ?? null) || null,
      method: req.method,
      path: String(req.path || '/').slice(0, 500),
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
      ip: req.ip,
      user_agent: String(req.headers['user-agent'] || '').slice(0, 200),
      request_id: req.id,
    });
    if (this.requestQueue.length > 2000) this.flushRequests();
  }

  flush() {
    if (!this.logQueue.length) return;
    const batch = this.logQueue.splice(0, this.logQueue.length);
    try {
      this.db.tx(() => {
        for (const l of batch) {
          this.db.run(
            'INSERT INTO logs (ts, level, source, message, meta_json, project_id, request_id) VALUES (?,?,?,?,?,?,?)',
            [l.ts, l.level, l.source, l.message, l.meta, l.project_id, l.request_id]
          );
        }
      });
    } catch (err) {
      this.log.debug(`log flush failed: ${err.message}`);
    }
  }

  flushRequests() {
    if (!this.requestQueue.length) return;
    const batch = this.requestQueue.splice(0, this.requestQueue.length);
    try {
      this.db.tx(() => {
        for (const r of batch) {
          this.db.run(
            'INSERT INTO request_logs (ts, project_id, method, path, status, duration_ms, ip, user_agent, request_id) VALUES (?,?,?,?,?,?,?,?,?)',
            [r.ts, r.project_id, r.method, r.path, r.status, r.duration_ms, r.ip, r.user_agent, r.request_id]
          );
        }
      });
    } catch (err) {
      this.log.debug(`request-log flush failed: ${err.message}`);
    }
  }

  prune() {
    try {
      const days = this.ctx.config.get('logging.retentionDays', 14);
      const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
      this.db.run('DELETE FROM logs WHERE ts < ?', [cutoff]);
      const reqDays = Math.min(days * 2, 60);
      const reqCutoff = new Date(Date.now() - reqDays * 86400_000).toISOString();
      this.db.run('DELETE FROM request_logs WHERE ts < ?', [reqCutoff]);
      this.flush(); this.flushRequests();
    } catch (err) {
      this.log.debug(`prune failed: ${err.message}`);
    }
  }

  searchLogs({ level = null, source = null, contains = null, since = null, until = null, projectId = null, limit = 200 } = {}) {
    this.flush(); // search sees the latest
    const clauses = [];
    const params = [];
    if (level) { clauses.push('level = ?'); params.push(level); }
    if (source) { clauses.push('source = ?'); params.push(source); }
    if (contains) { clauses.push('(message LIKE ? OR meta_json LIKE ?)'); params.push(`%${contains}%`, `%${contains}%`); }
    if (since) { clauses.push('ts >= ?'); params.push(since); }
    if (until) { clauses.push('ts <= ?'); params.push(until); }
    if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    return this.db.all(`SELECT * FROM logs${where} ORDER BY id DESC LIMIT ?`, [...params, Math.min(limit, 1000)]);
  }

  searchRequests({ projectId = null, status = null, minDurationMs = null, limit = 200 } = {}) {
    this.flushRequests();
    const clauses = [];
    const params = [];
    if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (minDurationMs) { clauses.push('duration_ms >= ?'); params.push(minDurationMs); }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    return this.db.all(`SELECT * FROM request_logs${where} ORDER BY id DESC LIMIT ?`, [...params, Math.min(limit, 1000)]);
  }

  async dashboardSummary() {
    const metrics = this.ctx.metrics.snapshot();
    const health = await this.ctx.health.run();
    const storageBytes = this.db.get('SELECT COALESCE(SUM(size),0) AS s FROM objects WHERE deleted = 0')?.s || 0;
    const projects = this.db.get('SELECT COUNT(*) AS c FROM projects')?.c || 0;
    const users = this.db.get('SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL')?.c || 0;
    const requests24h = this.db.get("SELECT COUNT(*) AS c FROM request_logs WHERE ts >= ?", [new Date(Date.now() - 86400_000).toISOString()])?.c || 0;
    const errors24h = this.db.get("SELECT COUNT(*) AS c FROM request_logs WHERE ts >= ? AND status >= 400", [new Date(Date.now() - 86400_000).toISOString()])?.c || 0;
    const backups = this.db.get("SELECT COUNT(*) AS c FROM backups WHERE status = 'verified'")?.c || 0;
    const lastBackup = this.db.get('SELECT created_at, name FROM backups ORDER BY created_at DESC LIMIT 1');
    const functions = this.db.get('SELECT COUNT(*) AS c FROM functions WHERE enabled = 1')?.c || 0;
    return {
      health: { status: health.status, checks: health.checks },
      uptimeSec: metrics.uptimeSec,
      version: this.ctx.version,
      rps: metrics.rps,
      requests24h,
      errors24h,
      errorRate: requests24h ? +((errors24h / requests24h) * 100).toFixed(2) : 0,
      latency: metrics.latencyMs,
      memory: metrics.memory,
      eventLoopLagMs: metrics.eventLoopLagMs,
      realtime: metrics.realtime,
      counts: { projects, users, storageBytes, backups, functions },
      lastBackup,
    };
  }
}

export async function register(ctx) {
  const svc = new ObservabilityService(ctx);
  ctx.observability = svc;
  svc.start();
  ctx.lifecycle?.registerShutdown?.('observability', () => {
    svc.flush(); svc.flushRequests();
    clearInterval(svc.flushTimer); clearInterval(svc.retentionTimer);
  });
}
