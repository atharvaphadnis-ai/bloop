// core/event-bus.js — in-process publish/subscribe hub with wildcard support.
// Every cross-module reaction (realtime broadcast, webhooks, function triggers,
// audit entries, CDC fan-out) flows through this bus.
export class EventBus {
  constructor({ logger = console } = {}) {
    this.channels = new Map(); // pattern -> Set<handler>
    this.wildcards = [];       // [{pattern, prefix, handler}]
    this.logger = logger;
    this.maxListeners = 100;
    this.stats = { emitted: 0, handled: 0, errors: 0 };
  }

  on(pattern, handler) {
    if (typeof handler !== 'function') throw new TypeError('event-bus: handler must be a function');
    if (pattern.includes('*') && !pattern.endsWith('.*')) {
      throw new TypeError(`event-bus: only trailing wildcards are supported (got "${pattern}")`);
    }
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      let entry = this.wildcards.find((w) => w.pattern === pattern);
      if (!entry) {
        entry = { pattern, prefix, handlers: new Set() };
        this.wildcards.push(entry);
      }
      entry.handlers.add(handler);
    } else {
      let set = this.channels.get(pattern);
      if (!set) {
        set = new Set();
        this.channels.set(pattern, set);
      }
      if (set.size >= this.maxListeners) {
        this.logger.warn?.(`event-bus: pattern "${pattern}" exceeded ${this.maxListeners} listeners`);
      }
      set.add(handler);
    }
    return () => this.off(pattern, handler);
  }

  once(pattern, handler) {
    const wrapped = (...args) => {
      this.off(pattern, wrapped);
      handler(...args);
    };
    wrapped._once = true;
    return this.on(pattern, wrapped);
  }

  off(pattern, handler) {
    if (pattern.endsWith('.*')) {
      const entry = this.wildcards.find((w) => w.pattern === pattern);
      if (entry) entry.handlers.delete(handler);
    } else {
      const set = this.channels.get(pattern);
      if (set) set.delete(handler);
    }
    return this;
  }

  emit(event, payload) {
    this.stats.emitted++;
    const direct = this.channels.get(event);
    if (direct) {
      for (const h of direct) this._invoke(h, event, payload);
    }
    for (const w of this.wildcards) {
      if (event.startsWith(w.prefix + '.') || event === w.prefix) {
        for (const h of w.handlers) this._invoke(h, event, payload);
      }
    }
  }

  _invoke(handler, event, payload) {
    try {
      const r = handler(payload, event);
      if (r && typeof r.catch === 'function') {
        r.catch((err) => {
          this.stats.errors++;
          this.logger.error?.(`event-bus: handler failed for "${event}": ${err?.message || err}`);
        });
      } else {
        this.stats.handled++;
      }
    } catch (err) {
      this.stats.errors++;
      this.logger.error?.(`event-bus: handler threw for "${event}": ${err?.message || err}`);
    }
  }

  // Emits and awaits all handlers (including promises) — used where ordering
  // matters, e.g. CDC fan-out before HTTP response returns.
  async emitAwait(event, payload) {
    const handlers = [];
    const direct = this.channels.get(event);
    if (direct) handlers.push(...direct);
    for (const w of this.wildcards) {
      if (event.startsWith(w.prefix + '.') || event === w.prefix) handlers.push(...w.handlers);
    }
    const results = [];
    for (const h of handlers) {
      try {
        results.push(await h(payload, event));
        this.stats.handled++;
      } catch (err) {
        this.stats.errors++;
        this.logger.error?.(`event-bus: async handler failed for "${event}": ${err?.message || err}`);
      }
    }
    return results;
  }

  listenerCount(event) {
    let n = (this.channels.get(event)?.size || 0);
    for (const w of this.wildcards) {
      if (event.startsWith(w.prefix + '.') || event === w.prefix) n += w.handlers.size;
    }
    return n;
  }

  clear() {
    this.channels.clear();
    this.wildcards = [];
  }
}
