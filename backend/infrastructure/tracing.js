// infrastructure/tracing.js — request tracing with AsyncLocalStorage, named
// spans (db, function, email, webhook, backup), correlation IDs and a ring
// buffer of recent traces for the dashboard waterfall view.
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

export class TracingService {
  constructor(ctx) {
    this.ctx = ctx;
    this.als = new AsyncLocalStorage();
    this.ring = [];
    this.capacity = ctx.config.get('observability.tracesBufferSize', 1000);
    this.log = ctx.log.child({ source: 'tracing' });
  }

  // Wrap a request — the root span + correlation context
  runWithRequest(req, res, fn) {
    const traceId = req.id || crypto.randomUUID();
    const ctxData = {
      traceId,
      requestId: req.id,
      method: req.method,
      path: req.path,
      ip: req.ip,
      startedAt: Date.now(),
      spans: [],
    };
    return this.als.run(ctxData, fn);
  }

  current() {
    return this.als.getStore() || null;
  }

  startSpan(name, type = 'internal', meta = {}) {
    const ctxData = this.current();
    const span = {
      id: crypto.randomUUID().slice(0, 8),
      traceId: ctxData?.traceId || null,
      name,
      type,
      meta,
      startedAt: Date.now(),
      durationMs: null,
      status: 'running',
    };
    if (ctxData) ctxData.spans.push(span);
    span.end = (status = 'ok') => {
      span.durationMs = Date.now() - span.startedAt;
      span.status = status;
    };
    return span;
  }

  addSpan(name, type, durationMs, status = 'ok', meta = {}) {
    // non-request-context spans (background jobs)
    this.ring.push({
      id: crypto.randomUUID().slice(0, 8),
      traceId: null,
      name,
      type,
      meta,
      durationMs,
      status,
      startedAt: Date.now(),
      isolated: true,
    });
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity);
  }

  recordRequest(req, res, durationMs, ctxData = null) {
    const store = ctxData || this.current();
    const trace = {
      id: store?.traceId || req.id,
      requestId: req.id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      ip: req.ip,
      startedAt: store?.startedAt || Date.now(),
      spans: (store?.spans || []).map((s) => ({
        id: s.id, name: s.name, type: s.type, durationMs: s.durationMs, status: s.status, meta: s.meta,
      })),
    };
    this.ring.push(trace);
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity);
  }

  recent({ limit = 100, path = null, minDurationMs = 0, status = null } = {}) {
    let out = this.ring;
    if (path) out = out.filter((t) => t.path?.includes(path));
    if (status) out = out.filter((t) => String(t.status) === String(status));
    if (minDurationMs) out = out.filter((t) => (t.durationMs || 0) >= minDurationMs);
    return out.slice(-limit);
  }

  get(traceId) {
    return this.ring.find((t) => t.id === traceId) || null;
  }

  stats() {
    const traces = this.ring;
    const slowest = [...traces].sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0)).slice(0, 5);
    return {
      tracesRecorded: traces.length,
      slowest: slowest.map((t) => ({ id: t.id, path: t.path, durationMs: t.durationMs, status: t.status })),
    };
  }
}

export async function register(ctx) {
  ctx.tracing = new TracingService(ctx);
  ctx.log.debug?.('tracing ready (AsyncLocalStorage)');
}
