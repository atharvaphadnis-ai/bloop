// core/logger.js — structured JSON logging with levels, file transport,
// redaction of secrets, in-memory tail buffer (for the Logs dashboard page
// and `bloop logs`) and optional pretty console output in development.
import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

const LEVELS = { error: 0, warn: 1, info: 2, http: 3, debug: 4, trace: 5 };
const REDACT_KEYS = /pass(word)?|secret|token|authorization|credential|api[-_]?key|private[-_]?key|client[-_]?secret|refresh/i;

let seq = 0;

export function redact(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') {
    if (REDACT_KEYS.test('') ) return value; // no-op guard; strings redacted only as values of keys
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEYS.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'function') return '[function]';
  return value;
}

export class Logger {
  constructor(opts = {}) {
    this.level = opts.level || 'info';
    this.context = opts.context || {};
    this.transports = opts.transports || [makeConsoleTransport(opts.pretty === true)];
    this.buffer = opts.buffer || null; // shared ring buffer
    this.onLog = opts.onLog || null;
  }

  isEnabled(level) {
    return (LEVELS[level] ?? 2) <= (LEVELS[this.level] ?? 2);
  }

  child(extra) {
    return new Logger({
      level: this.level,
      context: { ...this.context, ...extra },
      transports: this.transports,
      buffer: this.buffer,
      onLog: this.onLog,
      pretty: undefined,
    });
  }

  _log(level, args, extraCtx) {
    if (!this.isEnabled(level)) return;
    const msg = args.length === 1 && typeof args[0] === 'string' ? args[0] : format(...args);
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...this.context,
      ...(extraCtx || {}),
      seq: ++seq,
    };
    if (entry.meta) entry.meta = redact(entry.meta);
    if (this.buffer) this.buffer.push(entry);
    if (this.onLog) {
      try { this.onLog(entry); } catch { /* never break logging */ }
    }
    for (const t of this.transports) {
      try { t.write(entry); } catch (err) { /* transport failures must not crash the app */ }
    }
  }

  error(...args) { this._log('error', args); }
  warn(...args) { this._log('warn', args); }
  info(...args) { this._log('info', args); }
  http(...args) { this._log('http', args); }
  debug(...args) { this._log('debug', args); }
  trace(...args) { this._log('trace', args); }
  log(level, ...args) { this._log(level, args); }
}

export class RingBuffer {
  constructor(capacity = 5000) {
    this.capacity = capacity;
    this.items = [];
  }
  push(entry) {
    this.items.push(entry);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }
  query({ level, source, contains, since, limit = 200 } = {}) {
    let out = this.items;
    if (level) out = out.filter((e) => e.level === level);
    if (source) out = out.filter((e) => e.source === source);
    if (contains) out = out.filter((e) => (e.msg || '').includes(contains) || JSON.stringify(e.meta || '').includes(contains));
    if (since) out = out.filter((e) => e.ts >= since);
    return out.slice(-limit);
  }
}

function makeConsoleTransport(pretty) {
  return {
    write(entry) {
      if (!pretty) {
        console.log(JSON.stringify(entry));
        return;
      }
      const color = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', http: '\x1b[90m', debug: '\x1b[90m', trace: '\x1b[90m' }[entry.level] || '';
      const label = `${entry.level.toUpperCase().padEnd(5)}`;
      const ctx = entry.requestId ? ` [${entry.requestId}]` : '';
      console.log(`${color}${label}\x1b[0m ${entry.ts.slice(11, 19)}${ctx} ${entry.msg}`);
    },
  };
}

export function makeFileTransport(filePath) {
  let stream = null;
  let currentDay = '';
  return {
    write(entry) {
      try {
        const day = entry.ts.slice(0, 10);
        if (day !== currentDay || !stream) {
          if (stream) stream.end();
          const dir = path.dirname(filePath);
          fs.mkdirSync(dir, { recursive: true });
          const file = filePath.replace(/\.log$/, `-${day}.log`);
          stream = fs.createWriteStream(file, { flags: 'a' });
          currentDay = day;
        }
        stream.write(JSON.stringify(entry) + '\n');
      } catch { /* disk issues must not crash the server */ }
    },
    close() { if (stream) stream.end(); },
  };
}

export function createLogger({ level = 'info', pretty = false, logDir = null, buffer = null } = {}) {
  const transports = [makeConsoleTransport(pretty)];
  if (logDir) transports.push(makeFileTransport(path.join(logDir, 'bloop.log')));
  return new Logger({ level, transports, buffer });
}
