// core/rate-limiter.js — fixed-window rate limiter (per key: IP, API key,
// project or route) with headers, brute-force lockout support and stats.
export class RateLimiter {
  constructor({ logger = console } = {}) {
    this.buckets = new Map(); // key -> { count, resetAt }
    this.logger = logger;
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref?.();
    this.stats = { checks: 0, limited: 0 };
  }

  /**
   * Returns { allowed, remaining, limit, resetAt, retryAfterMs }
   */
  check(key, { max, windowMs }) {
    this.stats.checks++;
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count++;
    const allowed = bucket.count <= max;
    if (!allowed) this.stats.limited++;
    return {
      allowed,
      limit: max,
      remaining: Math.max(0, max - bucket.count),
      resetAt: bucket.resetAt,
      retryAfterMs: allowed ? 0 : bucket.resetAt - now,
    };
  }

  reset(key) {
    this.buckets.delete(key);
  }

  cleanup() {
    const now = Date.now();
    let removed = 0;
    for (const [k, b] of this.buckets) {
      if (b.resetAt <= now) { this.buckets.delete(k); removed++; }
    }
    if (removed > 0) this.logger.debug?.(`rate-limiter: evicted ${removed} expired buckets`);
    // hard cap memory
    if (this.buckets.size > 100_000) {
      const excess = this.buckets.size - 80_000;
      const it = this.buckets.keys();
      for (let i = 0; i < excess; i++) this.buckets.delete(it.next().value);
    }
  }

  statsSnapshot() {
    return { ...this.stats, activeBuckets: this.buckets.size };
  }

  stop() {
    clearInterval(this.cleanupInterval);
    this.buckets.clear();
  }
}

// Brute-force protection with exponential lockout, used by admin + project auth.
export class BruteForceGuard {
  constructor({ maxAttempts = 5, baseLockMs = 30_000, maxLockMs = 15 * 60_000 } = {}) {
    this.attempts = new Map(); // key -> { count, lockedUntil, lastAttempt }
    this.maxAttempts = maxAttempts;
    this.baseLockMs = baseLockMs;
    this.maxLockMs = maxLockMs;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.attempts) {
        if (v.lockedUntil < now && now - v.lastAttempt > 10 * 60_000) this.attempts.delete(k);
      }
    }, 60_000);
    this.sweeper.unref?.();
  }

  status(key) {
    const rec = this.attempts.get(key);
    if (!rec) return { locked: false, attempts: 0 };
    const locked = rec.lockedUntil > Date.now();
    return { locked, attempts: rec.count, retryAfterMs: locked ? rec.lockedUntil - Date.now() : 0 };
  }

  failure(key) {
    let rec = this.attempts.get(key) || { count: 0, lockedUntil: 0, lastAttempt: 0 };
    rec.count++;
    rec.lastAttempt = Date.now();
    if (rec.count >= this.maxAttempts) {
      const lockMs = Math.min(this.baseLockMs * Math.pow(2, rec.count - this.maxAttempts), this.maxLockMs);
      rec.lockedUntil = Date.now() + lockMs;
    }
    this.attempts.set(key, rec);
    return this.status(key);
  }

  success(key) {
    this.attempts.delete(key);
  }

  stop() {
    clearInterval(this.sweeper);
  }
}
