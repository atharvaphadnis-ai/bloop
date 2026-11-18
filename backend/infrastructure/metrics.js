// infrastructure/metrics.js — in-process metrics registry: counters, gauges,
// request duration histograms, per-request observation, system samplers
// (memory, CPU, event-loop lag) and Prometheus text exposition.
import os from 'node:os';

const HISTOGRAM_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export class MetricsRegistry {
  constructor(ctx) {
    this.ctx = ctx;
    this.counters = new Map();   // key -> value
    this.gauges = new Map();     // key -> value
    this.histograms = new Map(); // key -> {buckets, counts, sum, count}
    this.startedAt = Date.now();
    this.requestSamples = [];    // last N request records for quick RPS math
    this.sampler = null;
    this.lagMonitor = null;
    this._lagMs = 0;
  }

  increment(name, by = 1) {
    this.counters.set(name, (this.counters.get(name) || 0) + by);
  }

  setGauge(name, value) {
    this.gauges.set(name, value);
    return value;
  }

  getGauge(name) {
    return this.gauges.get(name) ?? 0;
  }

  histogram(name) {
    let h = this.histograms.get(name);
    if (!h) {
      h = { buckets: [...HISTOGRAM_BUCKETS_MS], counts: new Array(HISTOGRAM_BUCKETS_MS.length).fill(0), sum: 0, count: 0 };
      this.histograms.set(name, h);
    }
    return h;
  }

  observe(name, valueMs) {
    const h = this.histogram(name);
    h.sum += valueMs;
    h.count++;
    for (let i = 0; i < h.buckets.length; i++) {
      if (valueMs <= h.buckets[i]) h.counts[i]++;
    }
  }

  observeRequest(req, res, durationMs) {
    const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
    const method = req.method || 'GET';
    this.increment(`http_requests_total{method="${method}",status_class="${statusClass}"}`);
    this.increment('http_requests_total');
    if (res.statusCode >= 400) this.increment('http_errors_total');
    this.observe('http_request_duration_ms', durationMs);
    const now = Date.now();
    this.requestSamples.push(now);
    if (this.requestSamples.length > 10000) this.requestSamples.splice(0, this.requestSamples.length - 10000);
    // forward to request-log persistence (observability)
    this.ctx.observability?.recordRequestLog?.(req, res, durationMs);
  }

  // percentiles computed from histogram buckets (upper-bound approximation)
  percentile(name, p) {
    const h = this.histograms.get(name);
    if (!h || h.count === 0) return 0;
    const target = h.count * (p / 100);
    let cumulative = 0;
    for (let i = 0; i < h.buckets.length; i++) {
      cumulative += h.counts[i];
      if (cumulative >= target) return h.buckets[i];
    }
    return h.buckets[h.buckets.length - 1];
  }

  rps(windowMs = 10000) {
    const cutoff = Date.now() - windowMs;
    const recent = this.requestSamples.filter((t) => t >= cutoff).length;
    return +(recent / (windowMs / 1000)).toFixed(2);
  }

  start() {
    // event-loop lag monitor
    let last = Date.now();
    this.lagMonitor = setInterval(() => {
      const now = Date.now();
      this._lagMs = now - last - 1000;
      this.setGauge('event_loop_lag_ms', Math.max(0, this._lagMs));
      last = now;
    }, 1000);
    this.lagMonitor.unref?.();

    // system samplers
    this.sampler = setInterval(() => {
      try {
        const mem = process.memoryUsage();
        this.setGauge('process_memory_rss_bytes', mem.rss);
        this.setGauge('process_memory_heap_used_bytes', mem.heapUsed);
        this.setGauge('process_memory_heap_total_bytes', mem.heapTotal);
        this.setGauge('process_uptime_seconds', Math.floor(process.uptime()));
        this.setGauge('system_memory_free_bytes', os.freemem());
        this.setGauge('system_memory_total_bytes', os.totalmem());
        this.setGauge('system_loadavg_1m', +(os.loadavg()[0]).toFixed(2));
        const cpu = process.cpuUsage();
        this.setGauge('process_cpu_user_seconds_total', cpu.user / 1e6);
        this.setGauge('process_cpu_system_seconds_total', cpu.system / 1e6);
      } catch { /* sampling must never crash */ }
    }, 10_000);
    this.sampler.unref?.();
  }

  snapshot() {
    const mem = process.memoryUsage();
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      rps: this.rps(),
      requests: this.counters.get('http_requests_total') || 0,
      errors: this.counters.get('http_errors_total') || 0,
      latencyMs: {
        p50: this.percentile('http_request_duration_ms', 50),
        p95: this.percentile('http_request_duration_ms', 95),
        p99: this.percentile('http_request_duration_ms', 99),
      },
      eventLoopLagMs: Math.max(0, Math.round(this._lagMs)),
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
      },
      realtime: this.ctx.realtime?.stats?.() || null,
      rateLimiter: this.ctx.rateLimiter?.statsSnapshot?.() || null,
      gauges: Object.fromEntries(this.gauges),
      counters: Object.fromEntries(this.counters),
    };
  }

  prometheus() {
    const lines = [];
    lines.push('# HELP bloop_uptime_seconds Process uptime');
    lines.push('# TYPE bloop_uptime_seconds gauge');
    lines.push(`bloop_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`);
    for (const [name, value] of this.counters) {
      lines.push(`# TYPE bloop_${sanitizeMetricName(name.split('{')[0])} counter`);
      lines.push(`bloop_${name} ${value}`);
    }
    for (const [name, value] of this.gauges) {
      lines.push(`# TYPE bloop_${sanitizeMetricName(name.split('{')[0])} gauge`);
      lines.push(`bloop_${name} ${value}`);
    }
    for (const [name, h] of this.histograms) {
      const base = `bloop_${sanitizeMetricName(name.split('{')[0])}`;
      lines.push(`# TYPE ${base} histogram`);
      let cumulative = 0;
      for (let i = 0; i < h.buckets.length; i++) {
        cumulative += h.counts[i];
        lines.push(`${base}_bucket{le="${h.buckets[i]}"} ${cumulative}`);
      }
      lines.push(`${base}_bucket{le="+Inf"} ${h.count}`);
      lines.push(`${base}_sum ${h.sum}`);
      lines.push(`${base}_count ${h.count}`);
    }
    return lines.join('\n') + '\n';
  }

  stop() {
    clearInterval(this.sampler);
    clearInterval(this.lagMonitor);
  }
}

function sanitizeMetricName(name) {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

export async function register(ctx) {
  ctx.metrics = new MetricsRegistry(ctx);
  ctx.metrics.start();
  ctx.lifecycle?.registerShutdown?.('metrics', () => ctx.metrics.stop());
}
