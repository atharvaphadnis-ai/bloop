// modules/connection-pool.js — generic connection pool with min/max bounds,
// idle eviction, acquire timeouts, health validation and statistics.
// External SQL/NoSQL adapters use it for raw client objects; SQLite is
// single-file and single-connection by design.
export class ConnectionPool {
  constructor({ name = 'pool', factory, destroy, validate, min = 0, max = 10, idleTimeoutMs = 60_000, acquireTimeoutMs = 10_000 }) {
    if (typeof factory !== 'function') throw new TypeError('ConnectionPool: factory is required');
    this.name = name;
    this.factory = factory;
    this.destroy = destroy || (async () => { });
    this.validate = validate || null;
    this.min = min;
    this.max = max;
    this.idleTimeoutMs = idleTimeoutMs;
    this.acquireTimeoutMs = acquireTimeoutMs;
    this.idle = [];            // [{client, idleSince}]
    this.waiting = [];         // [{resolve, reject, timer}]
    this.total = 0;
    this.acquired = 0;
    this.stats = { created: 0, destroyed: 0, acquired: 0, released: 0, timeouts: 0, failedValidations: 0 };
    this.sweeper = setInterval(() => this.evictIdle(), Math.min(idleTimeoutMs, 30_000));
    this.sweeper.unref?.();
  }

  async acquire() {
    while (true) {
      const candidate = this.idle.pop();
      if (candidate) {
        if (this.validate) {
          try {
            const ok = await this.validate(candidate.client);
            if (!ok) { this.stats.failedValidations++; await this._destroyClient(candidate.client); continue; }
          } catch {
            this.stats.failedValidations++;
            await this._destroyClient(candidate.client);
            continue;
          }
        }
        this.acquired++;
        this.stats.acquired++;
        return candidate.client;
      }
      if (this.total < this.max) {
        this.total++;
        try {
          const client = await this.factory();
          this.stats.created++;
          this.acquired++;
          this.stats.acquired++;
          return client;
        } catch (err) {
          this.total--;
          throw err;
        }
      }
      // wait for a release
      const ticket = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = this.waiting.indexOf(entry);
          if (i !== -1) this.waiting.splice(i, 1);
          this.stats.timeouts++;
          reject(new Error(`ConnectionPool(${this.name}): acquire timeout after ${this.acquireTimeoutMs}ms`));
        }, this.acquireTimeoutMs);
        const entry = { resolve, reject, timer };
        this.waiting.push(entry);
      });
      return ticket;
    }
  }

  release(client) {
    this.acquired = Math.max(0, this.acquired - 1);
    this.stats.released++;
    const waiting = this.waiting.shift();
    if (waiting) {
      clearTimeout(waiting.timer);
      this.acquired++;
      waiting.resolve(client);
      return;
    }
    this.idle.push({ client, idleSince: Date.now() });
  }

  async _destroyClient(client) {
    try { await this.destroy(client); } catch { /* ignore */ }
    this.stats.destroyed++;
  }

  async evictIdle() {
    const now = Date.now();
    while (this.idle.length > this.min && this.idle.some((e) => now - e.idleSince > this.idleTimeoutMs)) {
      const idx = this.idle.findIndex((e) => now - e.idleSince > this.idleTimeoutMs);
      if (idx === -1) break;
      const [entry] = this.idle.splice(idx, 1);
      this.total--;
      await this._destroyClient(entry.client);
    }
  }

  statsSnapshot() {
    return { name: this.name, total: this.total, idle: this.idle.length, acquired: this.acquired, waiting: this.waiting.length, ...this.stats };
  }

  async drain() {
    clearInterval(this.sweeper);
    while (this.waiting.length) {
      const w = this.waiting.shift();
      clearTimeout(w.timer);
      w.reject(new Error('ConnectionPool drained'));
    }
    const clients = this.idle.splice(0, this.idle.length);
    for (const entry of clients) {
      this.total--;
      await this._destroyClient(entry.client);
    }
  }
}

export class PoolManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.pools = new Map(); // key: projectId:connectionId
  }

  key(projectId, connectionId) {
    return `${projectId}:${connectionId}`;
  }

  get(projectId, connectionId) {
    return this.pools.get(this.key(projectId, connectionId)) || null;
  }

  create(projectId, connectionId, options) {
    const pool = new ConnectionPool({ name: this.key(projectId, connectionId), ...options });
    this.pools.set(this.key(projectId, connectionId), pool);
    return pool;
  }

  async destroyPool(projectId, connectionId) {
    const pool = this.pools.get(this.key(projectId, connectionId));
    if (pool) {
      await pool.drain();
      this.pools.delete(this.key(projectId, connectionId));
    }
  }

  allStats() {
    return [...this.pools.values()].map((p) => p.statsSnapshot());
  }
}

export async function register(ctx) {
  ctx.pools = new PoolManager(ctx);
  ctx.log.debug?.('connection-pool manager ready');
}
