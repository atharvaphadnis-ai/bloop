// core/config.js — layered configuration: defaults < config/config.json < env vars.
// Provides deep get/set, validation and persistence to config/config.json.
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';

export class Config {
  constructor(rootDir, defaults, fileConfig, environment) {
    this.rootDir = rootDir;
    this.configDir = path.join(rootDir, 'config');
    this.fileConfigPath = path.join(this.configDir, 'config.json');
    this.defaults = defaults;
    this.file = fileConfig;
    this.env = environment;
    this.data = mergeDeep(clone(defaults), clone(fileConfig));
    this.applyEnvOverrides();
  }

  applyEnvOverrides() {
    const e = this.env;
    if (process.env.BLOOP_HOST) this.set('server.host', e.host);
    if (process.env.BLOOP_PORT) this.set('server.port', e.port);
    if (e.logLevel !== 'info') this.set('logging.level', e.logLevel);
    if (!e.sqliteEnabled) this.set('database.sqliteEnabled', false);
    if (process.env.BLOOP_RATE_LIMIT_MAX) this.set('security.rateLimit.max', e.rateLimitMax);
    if (process.env.BLOOP_RATE_LIMIT_WINDOW_MS) this.set('security.rateLimit.windowMs', e.rateLimitWindowMs);
    if (e.corsOrigins?.length && process.env.BLOOP_CORS_ORIGINS) this.set('security.corsOrigins', e.corsOrigins);
    if (process.env.BLOOP_MAX_BODY_SIZE) this.set('security.maxBodySize', process.env.BLOOP_MAX_BODY_SIZE);
  }

  get(keyPath, dflt) {
    if (keyPath === undefined) return this.data;
    const parts = keyPath.split('.');
    let cur = this.data;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return dflt;
      cur = cur[p];
    }
    return cur === undefined ? dflt : cur;
  }

  set(keyPath, value) {
    const parts = keyPath.split('.');
    let cur = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    return value;
  }

  has(keyPath) {
    return this.get(keyPath) !== undefined;
  }

  // Persist only the user-controlled layer (config/config.json), never defaults.
  save() {
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(this.fileConfigPath, JSON.stringify(this.file, null, 2) + '\n', 'utf8');
  }

  update(patch) {
    // Deep-merge a patch into the file layer, then rebuild the effective data.
    this.file = mergeDeep(clone(this.file), clone(patch));
    this.data = mergeDeep(clone(this.defaults), clone(this.file));
    this.applyEnvOverrides();
    this.save();
    return this.data;
  }

  validate() {
    const errors = [];
    const port = this.get('server.port');
    if (!Number.isInteger(port) || port < 0 || port > 65535) errors.push('server.port must be an integer between 1 and 65535 (0 = random port, for tests)');
    const host = this.get('server.host');
    if (typeof host !== 'string' || !host) errors.push('server.host must be a non-empty string');
    const rl = this.get('security.rateLimit');
    if (!rl || !Number.isInteger(rl.max) || rl.max < 1) errors.push('security.rateLimit.max must be a positive integer');
    if (!rl || !Number.isInteger(rl.windowMs) || rl.windowMs < 1000) errors.push('security.rateLimit.windowMs must be >= 1000ms');
    const cors = this.get('security.corsOrigins');
    if (!Array.isArray(cors)) errors.push('security.corsOrigins must be an array');
    if (!['error', 'warn', 'info', 'debug', 'trace'].includes(this.get('logging.level'))) {
      errors.push('logging.level must be one of error|warn|info|debug|trace');
    }
    return { ok: errors.length === 0, errors };
  }

  toJSON() {
    return this.data;
  }
}

export function loadConfig(rootDir, environment) {
  const defaultsPath = path.join(rootDir, 'config', 'default-config.json');
  let defaults = {};
  try {
    defaults = JSON.parse(readFileSync(defaultsPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read config/default-config.json: ${err.message}`);
  }
  const filePath = path.join(rootDir, 'config', 'config.json');
  let fileConfig = {};
  if (fs.existsSync(filePath)) {
    try {
      fileConfig = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new Error(`config/config.json is not valid JSON: ${err.message}`);
    }
  }
  const cfg = new Config(rootDir, defaults, fileConfig, environment);
  const v = cfg.validate();
  if (!v.ok) throw new Error('Invalid configuration:\n  - ' + v.errors.join('\n  - '));
  return cfg;
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

export function mergeDeep(target, src) {
  if (src === undefined) return target;
  if (!isPlainObject(src) || !isPlainObject(target)) return src;
  for (const key of Object.keys(src)) {
    if (isPlainObject(src[key])) {
      if (!isPlainObject(target[key])) target[key] = {};
      target[key] = mergeDeep(target[key], src[key]);
    } else {
      target[key] = src[key];
    }
  }
  return target;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
