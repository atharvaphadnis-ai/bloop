// infrastructure/security.js — master key management, AES-256-GCM secret
// encryption at rest, admin JWT sessions, redaction, CSRF token helper and
// platform settings storage. Initialized FIRST in the startup sequence.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../core/error-handler.js';

export class SecurityService {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'security' });
    this._masterKey = null;
    this._adminKey = null;
  }

  initialize() {
    const dir = path.join(this.ctx.env.dataDir, 'system');
    fs.mkdirSync(dir, { recursive: true });
    let secret = this.ctx.env.secret;
    if (!secret) {
      const keyFile = path.join(dir, 'secret.key');
      if (fs.existsSync(keyFile)) {
        secret = fs.readFileSync(keyFile, 'utf8').trim();
      } else {
        secret = crypto.randomBytes(48).toString('base64url');
        fs.writeFileSync(keyFile, secret, { mode: 0o600 });
        try { fs.chmodSync(keyFile, 0o600); } catch { }
        this.log.info('generated a new master key at storage/system/secret.key — back this file up; it protects all encrypted secrets');
      }
    }
    this._masterKey = crypto.createHash('sha256').update(`bloop:master:${secret}`).digest();
    this._adminKey = crypto.hkdfSync('sha256', this._masterKey, Buffer.from('bloop-admin'), Buffer.from('bloop-admin-jwt'), 32);
  }

  masterKey() {
    if (!this._masterKey) this.initialize();
    return this._masterKey;
  }

  adminJwtKey() {
    if (!this._adminKey) this.initialize();
    return Buffer.from(this._adminKey);
  }

  // ── AES-256-GCM secret encryption (format: enc:v1:iv:tag:ct, base64url) ──
  encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey(), iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
  }

  decrypt(payload) {
    const parts = String(payload || '').split(':');
    if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
      throw new AppError(500, 'DECRYPT_FAILED', 'Stored value is not in the expected encrypted format');
    }
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey(), Buffer.from(parts[2], 'base64url'));
      decipher.setAuthTag(Buffer.from(parts[3], 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64url')), decipher.final()]).toString('utf8');
    } catch (err) {
      throw new AppError(500, 'DECRYPT_FAILED', `Failed to decrypt stored secret (wrong master key?): ${err.message}`);
    }
  }

  isEncrypted(value) {
    return typeof value === 'string' && value.startsWith('enc:v1:');
  }

  // ── Hashing / tokens ──────────────────────────────────────────────────────
  sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
  }

  hmac(value, key = this.masterKey()) {
    return crypto.createHmac('sha256', key).update(String(value)).digest('hex');
  }

  randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
  }

  constantTimeEqual(a, b) {
    const ba = Buffer.from(String(a ?? ''));
    const bb = Buffer.from(String(b ?? ''));
    if (ba.length !== bb.length) {
      // still do a comparison to keep timing flat, then reject
      crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
      return false;
    }
    return crypto.timingSafeEqual(ba, bb);
  }

  // ── Admin JWT sessions ────────────────────────────────────────────────────
  signAdminJwt(payload, ttlSec = 3600) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({
      ...payload,
      typ: 'admin-session',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + ttlSec,
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', this.adminJwtKey()).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${sig}`;
  }

  verifyAdminJwt(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expected = crypto.createHmac('sha256', this.adminJwtKey()).update(`${header}.${body}`).digest('base64url');
    if (!this.constantTimeEqual(expected, sig)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (payload.typ !== 'admin-session') return null;
      if (payload.exp < Math.floor(Date.now() / 1000)) return null;
      return payload;
    } catch {
      return null;
    }
  }

  verifyAdminRequest(req) {
    const header = String(req.headers.authorization || '');
    if (!header.toLowerCase().startsWith('bearer ')) return null;
    const payload = this.verifyAdminJwt(header.slice(7).trim());
    if (!payload) return null;
    // session must still be alive (revocation support)
    const session = this.ctx.system?.get('SELECT * FROM admin_sessions WHERE id = ? AND revoked = 0', [payload.sid]);
    if (!session) return null;
    return { id: payload.sub, email: payload.email, role: payload.role, sessionId: payload.sid };
  }

  verifyCliToken(req) {
    const header = String(req.headers.authorization || '');
    if (!header.toLowerCase().startsWith('bearer ')) return false;
    const tokenFile = path.join(this.ctx.env.dataDir, 'system', 'cli-token');
    if (!fs.existsSync(tokenFile)) return false;
    const expected = fs.readFileSync(tokenFile, 'utf8').trim();
    return this.constantTimeEqual(expected, header.slice(7).trim());
  }

  // ── Redaction (defense in depth: logger already redacts) ──────────────────
  redact(value, depth = 0) {
    const RE = /pass(word)?|secret|token|authorization|credential|api[-_]?key|client[-_]?secret/i;
    if (depth > 8) return '[deep]';
    if (Array.isArray(value)) return value.map((v) => this.redact(v, depth + 1));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = RE.test(k) ? '[REDACTED]' : this.redact(v, depth + 1);
      return out;
    }
    return value;
  }

  escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // CSRF token (double-submit pattern — available for cookie-based plugins;
  // the dashboard itself uses Bearer tokens which are not CSRF-exposed).
  issueCsrfToken(sessionId) {
    return this.hmac(`csrf:${sessionId}`);
  }

  verifyCsrfToken(sessionId, token) {
    return this.constantTimeEqual(this.issueCsrfToken(sessionId), token);
  }

  // ── Platform settings store ───────────────────────────────────────────────
  settingsGet(scope, key, dflt = null) {
    const row = this.ctx.system.get('SELECT value_json FROM settings WHERE scope = ? AND key = ?', [scope, key]);
    if (!row) return dflt;
    try {
      const parsed = JSON.parse(row.value_json);
      return parsed;
    } catch {
      return row.value_json;
    }
  }

  settingsSet(scope, key, value) {
    this.ctx.system.run(
      `INSERT INTO settings (scope, key, value_json, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(scope, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [scope, key, JSON.stringify(value), new Date().toISOString()]
    );
    return value;
  }
}

export async function register(ctx) {
  const svc = new SecurityService(ctx);
  svc.initialize();
  ctx.security = svc;
}
