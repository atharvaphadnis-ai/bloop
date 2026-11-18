// core/health-check.js — aggregated health probes for the /health endpoint and
// the dashboard status widgets.
export class HealthCheck {
  constructor(ctx) {
    this.ctx = ctx;
    this.checks = new Map(); // name -> async fn returning {status, detail}
  }

  register(name, fn) {
    this.checks.set(name, fn);
    return this;
  }

  async run() {
    const results = [];
    for (const [name, fn] of this.checks) {
      const started = Date.now();
      try {
        const r = await Promise.race([
          Promise.resolve(fn()),
          new Promise((_, reject) => setTimeout(() => reject(new Error('health check timeout')), 5000)),
        ]);
        results.push({ name, status: r?.status || 'ok', detail: r?.detail ?? r ?? null, durationMs: Date.now() - started });
      } catch (err) {
        results.push({ name, status: 'down', detail: err.message, durationMs: Date.now() - started });
      }
    }
    const down = results.filter((r) => r.status === 'down').length;
    const degraded = results.filter((r) => r.status === 'degraded').length;
    const status = down > 0 ? 'down' : degraded > 0 ? 'degraded' : 'ok';
    return {
      status,
      uptimeSec: Math.floor(process.uptime()),
      version: this.ctx.version || '1.0.0',
      timestamp: new Date().toISOString(),
      checks: results,
    };
  }
}

export function registerCoreChecks(ctx) {
  const health = ctx.health;
  health.register('system-database', async () => {
    const row = ctx.system.get('SELECT COUNT(*) AS c FROM sqlite_master');
    return { status: row ? 'ok' : 'down', detail: { objects: row.c } };
  });
  health.register('storage-writable', async () => {
    const fs = await import('node:fs/promises');
    const probe = ctx.env.dataDir + '/.health-probe';
    await fs.writeFile(probe, String(Date.now()));
    await fs.unlink(probe);
    return { status: 'ok', detail: { dir: ctx.env.dataDir } };
  });
  health.register('event-loop', async () => {
    const lagMs = ctx.metrics?.getGauge?.('event_loop_lag_ms') ?? 0;
    return { status: lagMs > 1000 ? 'degraded' : 'ok', detail: { lagMs: Math.round(lagMs) } };
  });
}
