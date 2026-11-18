// core/environment.js — environment variable loading and runtime mode.
// Parses an optional .env file (no dependency on external dotenv packages),
// normalizes values and exposes a frozen snapshot used across the platform.
import fs from 'node:fs';
import path from 'node:path';

const BOOLS = new Set(['true', '1', 'yes', 'on']);
const FALSES = new Set(['false', '0', 'no', 'off']);

export function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (let line of raw.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // strip trailing inline comments for unquoted values
    if (!val.startsWith('"') && !val.startsWith("'")) {
      const hash = val.indexOf(' #');
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

function toBool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  v = String(v).toLowerCase();
  if (BOOLS.has(v)) return true;
  if (FALSES.has(v)) return false;
  return dflt;
}

function toInt(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function parseSize(v, dfltBytes) {
  if (!v) return dfltBytes;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i.exec(String(v).trim());
  if (!m) return dfltBytes;
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[(m[2] || 'b').toLowerCase()];
  return Math.round(parseFloat(m[1]) * mult);
}

export function loadEnvironment(rootDir) {
  const fileVars = parseEnvFile(path.join(rootDir, '.env'));
  const get = (name) => process.env[name] ?? fileVars[name];

  const nodeEnv = (get('NODE_ENV') || 'production').toLowerCase();
  const dataDir = path.resolve(rootDir, get('BLOOP_DATA_DIR') || 'storage');
  const backupDir = path.resolve(rootDir, get('BLOOP_BACKUP_DIR') || 'backups');
  const sqliteEnabled = toBool(get('BLOOP_SQLITE_ENABLED'), true);

  const env = {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    isDevelopment: nodeEnv === 'development',
    isTest: nodeEnv === 'test',
    rootDir,
    dataDir,
    backupDir,
    host: get('BLOOP_HOST') || '0.0.0.0',
    port: toInt(get('BLOOP_PORT'), 8090),
    logLevel: (get('BLOOP_LOG_LEVEL') || 'info').toLowerCase(),
    logRetentionDays: toInt(get('BLOOP_LOG_RETENTION_DAYS'), 14),
    secret: get('BLOOP_SECRET') || '',
    sqliteEnabled,
    corsOrigins: (get('BLOOP_CORS_ORIGINS') || '*').split(',').map((s) => s.trim()).filter(Boolean),
    rateLimitMax: toInt(get('BLOOP_RATE_LIMIT_MAX'), 600),
    rateLimitWindowMs: toInt(get('BLOOP_RATE_LIMIT_WINDOW_MS'), 60000),
    maxBodySize: parseSize(get('BLOOP_MAX_BODY_SIZE'), 50 * 1024 * 1024),
    cliTokenEnabled: toBool(get('BLOOP_CLI_TOKEN_ENABLED'), true),
    telemetry: false, // Bloop never sends telemetry
    platform: process.platform,
    nodeVersion: process.version,
    pid: process.pid,
  };
  return Object.freeze(env);
}
