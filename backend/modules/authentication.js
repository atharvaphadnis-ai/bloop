// modules/authentication.js — complete end-user authentication per project:
// email/password with scrypt hashing, email verification, password reset,
// sessions with rotating refresh tokens, JWT access tokens, TOTP MFA,
// WebAuthn passkeys (CBOR + COSE + ES256 verification, no dependencies),
// OAuth account linking, and admin user management.
import crypto from 'node:crypto';
import { badRequest, unauthorized, notFound, conflict, forbidden } from '../core/error-handler.js';
import { validateOrThrow } from '../core/validation.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_SEC = 30 * 86400;
const MFA_TTL_SEC = 180;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ── Password hashing (scrypt — modern, memory-hard, built into Node) ─────────
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt:')) return false;
  const [, n, r, p, saltB64, hashB64] = stored.split(':');
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: +n, r: +r, p: +p });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ── JWT (HS256) ──────────────────────────────────────────────────────────────
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function sign(payload, key, ttlSec) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  }));
  const sig = b64url(crypto.createHmac('sha256', key).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

function verify(token, key) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto.createHmac('sha256', key).update(`${header}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function projectJwtKey(masterKey, projectId) {
  return crypto.hkdfSync('sha256', masterKey, Buffer.from(projectId), Buffer.from('bloop-project-jwt'), 32);
}

// ── TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30s) ────────────────────────────────
export function generateTotpSecret() {
  const buf = crypto.randomBytes(20);
  let bits = '';
  for (const byte of buf) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(str) {
  let bits = '';
  for (const c of str.toUpperCase().replace(/=+$/, '')) {
    const idx = B32.indexOf(c);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpCode(secretB32, { offsetSec = 0 } = {}) {
  const key = base32Decode(secretB32);
  const counter = Math.floor((Date.now() / 1000 + offsetSec) / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = h[h.length - 1] & 0x0f;
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

export function verifyTotp(secretB32, code) {
  for (const offset of [-30, 0, 30]) {
    if (totpCode(secretB32, { offsetSec: offset }) === String(code)) return true;
  }
  return false;
}

export function totpUrl(secret, email, issuer = 'Bloop') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ── CBOR decoding (RFC 8949 subset, for WebAuthn) ────────────────────────────
export function cborDecode(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let pos = 0;
  function read(len) {
    if (pos + len > data.length) throw new Error('CBOR: unexpected end');
    const out = data.subarray(pos, pos + len);
    pos += len;
    return out;
  }
  function readUint(len) {
    const b = read(len);
    let v = 0n;
    for (const byte of b) v = (v << 8n) | BigInt(byte);
    return v;
  }
  function decodeItem() {
    const first = data[pos];
    const major = first >> 5;
    const info = first & 0x1f;
    pos++;
    const readLen = () => {
      if (info < 24) return info;
      if (info === 24) return read(1)[0];
      if (info === 25) return Number(readUint(2));
      if (info === 26) return Number(readUint(4));
      if (info === 27) return Number(readUint(8));
      throw new Error(`CBOR: unsupported length info ${info}`);
    };
    switch (major) {
      case 0: return Number(readLen());
      case 1: return -1 - Number(readLen());
      case 2: return read(readLen());                       // byte string
      case 3: return read(readLen()).toString('utf8');      // text string
      case 4: {
        const len = readLen();
        const arr = [];
        for (let i = 0; i < len; i++) arr.push(decodeItem());
        return arr;
      }
      case 5: {
        const len = readLen();
        const map = {};
        for (let i = 0; i < len; i++) {
          const k = decodeItem();
          map[typeof k === 'number' ? `k${k}` : String(k)] = decodeItem();
        }
        return map;
      }
      case 6: { decodeItem(); return { tagged: true }; }    // skip tag content marker
      case 7: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 27) { const v = read(8); return v.readDoubleBE(0); }
        return null;
      }
      default: throw new Error(`CBOR: unsupported major type ${major}`);
    }
  }
  const result = decodeItem();
  return result;
}

// ── WebAuthn helpers ─────────────────────────────────────────────────────────
function parseAuthData(authDataBuf) {
  if (authDataBuf.length < 37) throw new Error('authenticatorData too short');
  const rpIdHash = authDataBuf.subarray(0, 32);
  const flags = authDataBuf[32];
  const signCount = authDataBuf.readUInt32BE(33);
  let attested = null;
  if (flags & 0x40) { // AT — attested credential data present
    let idx = 37;
    const aaguid = authDataBuf.subarray(idx, idx + 16); idx += 16;
    const credIdLen = authDataBuf.readUInt16BE(idx); idx += 2;
    const credentialId = authDataBuf.subarray(idx, idx + credIdLen); idx += credIdLen;
    const coseKey = cborDecode(authDataBuf.subarray(idx));
    attested = { aaguid, credentialId, coseKey };
  }
  return { rpIdHash, flags, signCount, attested };
}

// COSE key → Node KeyObject (EC2 / P-256 / ES256 — the algorithm virtually all
// platform authenticators use; others are reported as unsupported).
function coseKeyToObject(cose) {
  const kty = cose['k1'];
  const alg = cose['k3'];
  if (kty !== 2) throw new Error(`unsupported COSE key type ${kty} (only EC2/ES256 passkeys are supported)`);
  if (alg !== -7 && alg !== -257) throw new Error(`unsupported COSE algorithm ${alg}`);
  const x = Buffer.from(cose['k-2']);
  const y = Buffer.from(cose['k-3']);
  if (x.length !== 32 || y.length !== 32) throw new Error('unexpected EC2 coordinate size');
  const jwk = { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url'), ext: true };
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

function verifyEs256(publicKey, dataBuf, sigBuf) {
  // WebAuthn signatures may be DER or raw r||s; normalize to DER for Node.
  let sig = sigBuf;
  if (sig.length === 64) {
    const r = sig.subarray(0, 32), s = sig.subarray(32, 64);
    const derR = r[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), r]) : r;
    const derS = s[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), s]) : s;
    sig = Buffer.concat([
      Buffer.from([0x30, 2 + derR.length + 2 + derS.length, 0x02, derR.length]), derR,
      Buffer.from([0x02, derS.length]), derS,
    ]);
  }
  return crypto.verify('sha256', dataBuf, publicKey, sig);
}

class Authentication {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'auth' });
    this.challenges = new Map(); // challengeId -> {challenge, type, projectId, userId?, expiresAt}
    this.challengeSweeper = setInterval(() => {
      const now = Date.now();
      for (const [k, c] of this.challenges) if (c.expiresAt < now) this.challenges.delete(k);
    }, 60_000);
    this.challengeSweeper.unref?.();
  }

  get db() { return this.ctx.system; }

  _projectKey(projectId) {
    return Buffer.from(projectJwtKey(this.ctx.security.masterKey(), projectId));
  }

  // ── Tokens ────────────────────────────────────────────────────────────────
  issueTokens(projectId, user, session, { claims = null } = {}) {
    const key = this._projectKey(projectId);
    const accessToken = sign({
      sub: user.id, sid: session.id, email: user.email,
      role: 'authenticated', project: projectId,
      claims: claims || JSON.parse(user.claims_json || '{}'),
      typ: 'access',
    }, key, ACCESS_TTL_SEC);
    const refreshToken = crypto.randomBytes(48).toString('base64url');
    const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    this.db.run('UPDATE sessions SET refresh_hash = ? WHERE id = ?', [refreshHash, session.id]);
    return {
      accessToken, refreshToken,
      expiresIn: ACCESS_TTL_SEC,
      tokenType: 'Bearer',
      user: this.publicUser(user),
    };
  }

  verifyAccessToken(projectId, token) {
    const payload = verify(token, this._projectKey(projectId));
    if (!payload || payload.project !== projectId || payload.typ !== 'access') return null;
    const session = this.db.get('SELECT * FROM sessions WHERE id = ?', [payload.sid]);
    if (!session || session.revoked_at) return null;
    if (session.expires_at < new Date().toISOString()) return null;
    return { payload, session };
  }

  mfaToken(projectId, userId) {
    return sign({ sub: userId, project: projectId, typ: 'mfa' }, this._projectKey(projectId), MFA_TTL_SEC);
  }

  verifyMfaToken(projectId, token) {
    const payload = verify(token, this._projectKey(projectId));
    return payload && payload.typ === 'mfa' && payload.project === projectId ? payload : null;
  }

  publicUser(user) {
    if (!user) return null;
    return {
      id: user.id, email: user.email, emailVerified: !!user.email_verified,
      metadata: JSON.parse(user.metadata_json || '{}'),
      claims: JSON.parse(user.claims_json || '{}'),
      totpEnabled: !!user.totp_enabled,
      disabled: !!user.disabled,
      createdAt: user.created_at, lastLoginAt: user.last_login_at,
    };
  }

  _authLog(projectId, event, { userId = null, email = null, success = true, detail = null, req = null } = {}) {
    try {
      this.db.run(
        'INSERT INTO auth_logs (ts, project_id, event, user_id, email, ip, user_agent, success, detail_json) VALUES (?,?,?,?,?,?,?,?,?)',
        [new Date().toISOString(), projectId, event, userId, email, req?.ip || null, (req?.headers?.['user-agent'] || '').slice(0, 120), success ? 1 : 0, detail ? JSON.stringify(detail) : null]
      );
    } catch { /* logging must not break auth */ }
    this.ctx.bus.emit(`auth.${event}`, { projectId, userId, email, success, detail });
  }

  // ── Registration / login ──────────────────────────────────────────────────
  async register(projectId, input, req) {
    const data = validateOrThrow({
      email: { type: 'email', required: true, max: 200 },
      password: { type: 'string', required: true, min: 8, max: 200 },
      metadata: { type: 'object' },
    }, input);
    const existing = this.db.get('SELECT id FROM users WHERE project_id = ? AND email = ?', [projectId, data.email.toLowerCase()]);
    if (existing) throw conflict('An account with this email already exists');
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO users (id, project_id, email, password_hash, email_verified, metadata_json, created_at, updated_at) VALUES (?,?,?,?,0,?,?,?)',
      [id, projectId, data.email.toLowerCase(), hashPassword(data.password), JSON.stringify(data.metadata || {}), now, now]
    );
    const user = this.db.get('SELECT * FROM users WHERE id = ?', [id]);
    const verification = this._issueToken(projectId, id, 'email_verify', 24 * 3600);
    const emailed = await this.ctx.email?.sendVerification?.(projectId, user.email, verification.token).catch(() => null);
    this._authLog(projectId, 'register', { userId: id, email: user.email, req, detail: { emailed: !!emailed?.sent } });
    this.ctx.bus.emit('auth.user.created', { projectId, userId: id, email: user.email });
    return {
      user: this.publicUser(user),
      emailVerification: emailed?.sent
        ? { sent: true }
        : { sent: false, token: verification.token, note: 'SMTP is not configured — token returned for development. Configure SMTP in Authentication → Email to send real emails.' },
    };
  }

  _issueToken(projectId, userId, type, ttlSec) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.db.run('INSERT INTO tokens (id, project_id, user_id, type, token_hash, expires_at, created_at) VALUES (?,?,?,?,?,?,?)',
      [crypto.randomUUID(), projectId, userId, type, crypto.createHash('sha256').update(token).digest('hex'),
        new Date(Date.now() + ttlSec * 1000).toISOString(), new Date().toISOString()]);
    return { token };
  }

  _consumeToken(projectId, type, token) {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const row = this.db.get('SELECT * FROM tokens WHERE project_id = ? AND type = ? AND token_hash = ? AND used_at IS NULL', [projectId, type, hash]);
    if (!row) throw badRequest('Invalid or already-used token');
    if (row.expires_at < new Date().toISOString()) throw badRequest('Token has expired — request a new one');
    this.db.run('UPDATE tokens SET used_at = ? WHERE id = ?', [new Date().toISOString(), row.id]);
    return row;
  }

  verifyEmail(projectId, token) {
    const row = this._consumeToken(projectId, 'email_verify', token);
    this.db.run('UPDATE users SET email_verified = 1 WHERE id = ?', [row.user_id]);
    this._authLog(projectId, 'email_verified', { userId: row.user_id });
    return { verified: true };
  }

  async login(projectId, input, req) {
    const data = validateOrThrow({
      email: { type: 'email', required: true },
      password: { type: 'string', required: true },
    }, input);
    const lockKey = `login:${projectId}:${req.ip}:${data.email.toLowerCase()}`;
    const lock = this.ctx.bruteForce.status(lockKey);
    if (lock.locked) {
      this._authLog(projectId, 'login_locked', { email: data.email, success: false, req });
      throw unauthorized(`Account temporarily locked after repeated failures. Retry in ${Math.ceil(lock.retryAfterMs / 1000)}s.`);
    }
    const user = this.db.get('SELECT * FROM users WHERE project_id = ? AND email = ? AND deleted_at IS NULL', [projectId, data.email.toLowerCase()]);
    if (!user || !verifyPassword(data.password, user.password_hash)) {
      const after = this.ctx.bruteForce.failure(lockKey);
      this._authLog(projectId, 'login_failed', { email: data.email, success: false, req, detail: { attempts: after.attempts } });
      throw unauthorized('Invalid email or password');
    }
    if (user.disabled) throw forbidden('This account is disabled');
    if (user.deleted_at) throw forbidden('This account has been deleted');
    const requireRow = this.db.get("SELECT value_json FROM settings WHERE scope='security' AND key='requireEmailVerification'");
    const requireVerification = requireRow ? (JSON.parse(requireRow.value_json) === true) : false;
    if (requireVerification && !user.email_verified) {
      throw forbidden('Email not verified. Check your inbox or request a new verification email.');
    }
    this.ctx.bruteForce.success(lockKey);
    if (user.totp_enabled) {
      this._authLog(projectId, 'mfa_challenge', { userId: user.id, email: user.email, req });
      return { mfaRequired: true, mfaToken: this.mfaToken(projectId, user.id) };
    }
    return this._finishLogin(projectId, user, req);
  }

  async loginMfa(projectId, mfaToken, code, req) {
    const payload = this.verifyMfaToken(projectId, mfaToken);
    if (!payload) throw unauthorized('MFA session expired — log in again');
    const user = this.db.get('SELECT * FROM users WHERE id = ? AND project_id = ?', [payload.sub, projectId]);
    if (!user || !user.totp_secret || !verifyTotp(user.totp_secret, code)) {
      this._authLog(projectId, 'mfa_failed', { userId: payload.sub, success: false, req });
      throw unauthorized('Invalid authentication code');
    }
    return this._finishLogin(projectId, user, req);
  }

  _finishLogin(projectId, user, req) {
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO sessions (id, project_id, user_id, ip, user_agent, created_at, expires_at) VALUES (?,?,?,?,?,?,?)',
      [sessionId, projectId, user.id, req?.ip || null, (req?.headers?.['user-agent'] || '').slice(0, 160), now,
        new Date(Date.now() + REFRESH_TTL_SEC * 1000).toISOString()]
    );
    this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [now, user.id]);
    this._authLog(projectId, 'login', { userId: user.id, email: user.email, req });
    const session = this.db.get('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    return this.issueTokens(projectId, user, session);
  }

  async refresh(projectId, refreshToken, req) {
    const hash = crypto.createHash('sha256').update(String(refreshToken || '')).digest('hex');
    const session = this.db.get('SELECT * FROM sessions WHERE refresh_hash = ? AND project_id = ?', [hash, projectId]);
    if (!session || session.revoked_at || session.expires_at < new Date().toISOString()) {
      throw unauthorized('Invalid refresh token');
    }
    const user = this.db.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [session.user_id]);
    if (!user || user.disabled) throw unauthorized('Account unavailable');
    // rotation: issueTokens generates a fresh refresh token and stores its
    // hash — the single rotation point (no double write).
    this.db.run('UPDATE sessions SET expires_at = ? WHERE id = ?',
      [new Date(Date.now() + REFRESH_TTL_SEC * 1000).toISOString(), session.id]);
    const fresh = this.db.get('SELECT * FROM sessions WHERE id = ?', [session.id]);
    return this.issueTokens(projectId, user, fresh);
  }

  logout(projectId, refreshToken) {
    const hash = crypto.createHash('sha256').update(String(refreshToken || '')).digest('hex');
    const session = this.db.get('SELECT * FROM sessions WHERE refresh_hash = ? AND project_id = ?', [hash, projectId]);
    if (session) {
      this.db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [new Date().toISOString(), session.id]);
      this._authLog(projectId, 'logout', { userId: session.user_id });
    }
    return { loggedOut: true };
  }

  revokeSession(projectId, userId, sessionId) {
    const s = this.db.get('SELECT * FROM sessions WHERE id = ? AND project_id = ? AND user_id = ?', [sessionId, projectId, userId]);
    if (!s) throw notFound('Session not found');
    this.db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [new Date().toISOString(), sessionId]);
    return { revoked: true };
  }

  revokeAllSessions(projectId, userId) {
    this.db.run('UPDATE sessions SET revoked_at = ? WHERE project_id = ? AND user_id = ? AND revoked_at IS NULL',
      [new Date().toISOString(), projectId, userId]);
    return { revokedAll: true };
  }

  listSessions(projectId, userId) {
    return this.db.all(
      'SELECT id, ip, user_agent, created_at, expires_at, revoked_at FROM sessions WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 50',
      [projectId, userId]
    );
  }

  // ── Password reset ────────────────────────────────────────────────────────
  async requestPasswordReset(projectId, email, req) {
    const user = this.db.get('SELECT * FROM users WHERE project_id = ? AND email = ? AND deleted_at IS NULL', [projectId, String(email).toLowerCase()]);
    // Do not reveal whether the account exists (enumeration protection).
    if (!user) return { sent: true };
    const { token } = this._issueToken(projectId, user.id, 'password_reset', 3600);
    const emailed = await this.ctx.email?.sendPasswordReset?.(projectId, user.email, token).catch(() => null);
    this._authLog(projectId, 'password_reset_requested', { userId: user.id, email: user.email, req, detail: { emailed: !!emailed?.sent } });
    return emailed?.sent
      ? { sent: true }
      : { sent: false, token, note: 'SMTP is not configured — token returned for development.' };
  }

  async resetPassword(projectId, token, newPassword) {
    if (!newPassword || String(newPassword).length < 8) throw badRequest('Password must be at least 8 characters');
    const row = this._consumeToken(projectId, 'password_reset', token);
    this.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [hashPassword(newPassword), new Date().toISOString(), row.user_id]);
    this.revokeAllSessions(projectId, row.user_id);
    this._authLog(projectId, 'password_reset_completed', { userId: row.user_id });
    return { reset: true };
  }

  changePassword(projectId, userId, oldPassword, newPassword) {
    const user = this.db.get('SELECT * FROM users WHERE id = ? AND project_id = ?', [userId, projectId]);
    if (!user || !verifyPassword(oldPassword, user.password_hash)) throw unauthorized('Current password is incorrect');
    if (!newPassword || String(newPassword).length < 8) throw badRequest('Password must be at least 8 characters');
    this.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [hashPassword(newPassword), new Date().toISOString(), userId]);
    return { changed: true };
  }

  // ── Profile ───────────────────────────────────────────────────────────────
  me(projectId, userId) {
    const user = this.db.get('SELECT * FROM users WHERE id = ? AND project_id = ?', [userId, projectId]);
    if (!user || user.deleted_at) throw notFound('User not found');
    return this.publicUser(user);
  }

  updateProfile(projectId, userId, patch) {
    const user = this.db.get('SELECT * FROM users WHERE id = ? AND project_id = ?', [userId, projectId]);
    if (!user) throw notFound('User not found');
    const data = validateOrThrow({
      email: { type: 'email' },
      metadata: { type: 'object' },
    }, patch);
    if (data.email && data.email.toLowerCase() !== user.email) {
      const clash = this.db.get('SELECT id FROM users WHERE project_id = ? AND email = ?', [projectId, data.email.toLowerCase()]);
      if (clash) throw conflict('Email already in use');
      this.db.run('UPDATE users SET email = ?, email_verified = 0 WHERE id = ?', [data.email.toLowerCase(), userId]);
    }
    if (data.metadata !== undefined) {
      this.db.run('UPDATE users SET metadata_json = ? WHERE id = ?', [JSON.stringify(data.metadata), userId]);
    }
    this.db.run('UPDATE users SET updated_at = ? WHERE id = ?', [new Date().toISOString(), userId]);
    return this.me(projectId, userId);
  }

  async deleteAccount(projectId, userId) {
    this.revokeAllSessions(projectId, userId);
    this.db.run('UPDATE users SET deleted_at = ?, disabled = 1, password_hash = ?, metadata_json = ? WHERE id = ?',
      [new Date().toISOString(), 'deleted', '{}', userId]);
    this._authLog(projectId, 'account_deleted', { userId });
    this.ctx.bus.emit('auth.account.deleted', { projectId, userId });
    return { deleted: true, note: 'Account deactivated and sessions revoked. Personal data is retained until you purge it from the database.' };
  }

  // ── OAuth account linking (called by infrastructure/oauth.js) ─────────────
  async completeOAuth(projectId, { provider, providerUserId, email, metadata = {}, emailVerified = false }, req) {
    const identity = this.db.get(
      'SELECT ui.* FROM user_identities ui WHERE ui.project_id = ? AND ui.provider = ? AND ui.provider_user_id = ?',
      [projectId, provider, providerUserId]
    );
    let user;
    if (identity) {
      user = this.db.get('SELECT * FROM users WHERE id = ?', [identity.user_id]);
    } else if (email) {
      user = this.db.get('SELECT * FROM users WHERE project_id = ? AND email = ? AND deleted_at IS NULL', [projectId, String(email).toLowerCase()]);
    }
    const now = new Date().toISOString();
    if (!user) {
      // auto-create the account (standard BaaS behavior for OAuth-first flows)
      const id = crypto.randomUUID();
      this.db.run(
        'INSERT INTO users (id, project_id, email, password_hash, email_verified, metadata_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [id, projectId, email || `${provider}_${providerUserId}@oauth.local`, 'oauth:' + crypto.randomBytes(32).toString('hex'),
          emailVerified ? 1 : 0, JSON.stringify(metadata), now, now]
      );
      user = this.db.get('SELECT * FROM users WHERE id = ?', [id]);
    }
    if (user.disabled || user.deleted_at) throw forbidden('Account disabled');
    if (!identity) {
      this.db.run('INSERT INTO user_identities (id, user_id, project_id, provider, provider_user_id, metadata_json, created_at) VALUES (?,?,?,?,?,?,?)',
        [crypto.randomUUID(), user.id, projectId, provider, providerUserId, JSON.stringify(metadata), now]);
    }
    this._authLog(projectId, 'oauth_login', { userId: user.id, email: user.email, req, detail: { provider } });
    return this._finishLogin(projectId, user, req);
  }

  // ── TOTP ──────────────────────────────────────────────────────────────────
  totpEnroll(projectId, userId) {
    const secret = generateTotpSecret();
    this.db.run('UPDATE users SET totp_secret = ? WHERE id = ?', [secret, userId]);
    const user = this.db.get('SELECT email FROM users WHERE id = ?', [userId]);
    return { secret, otpauthUrl: totpUrl(secret, user?.email || 'user') };
  }

  totpEnable(projectId, userId, code) {
    const user = this.db.get('SELECT totp_secret FROM users WHERE id = ?', [userId]);
    if (!user?.totp_secret) throw badRequest('Enroll first');
    if (!verifyTotp(user.totp_secret, code)) throw badRequest('Invalid authentication code — check your device clock');
    this.db.run('UPDATE users SET totp_enabled = 1 WHERE id = ?', [userId]);
    this._authLog(projectId, 'totp_enabled', { userId });
    return { enabled: true };
  }

  totpDisable(projectId, userId, password) {
    const user = this.db.get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user?.totp_enabled) throw badRequest('TOTP is not enabled');
    if (!verifyPassword(password, user.password_hash)) throw unauthorized('Password incorrect');
    this.db.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', [userId]);
    return { disabled: true };
  }

  // ── Passkeys (WebAuthn) ───────────────────────────────────────────────────
  _storeChallenge(projectId, type, userId = null, ttlSec = 120) {
    const challenge = crypto.randomBytes(32).toString('base64url');
    const id = crypto.randomUUID();
    this.challenges.set(id, { challenge, type, projectId, userId, expiresAt: Date.now() + ttlSec * 1000 });
    return { id, challenge };
  }

  _takeChallenge(id, expectedType, projectId) {
    const c = this.challenges.get(id);
    if (!c || c.expiresAt < Date.now() || c.type !== expectedType || c.projectId !== projectId) {
      throw unauthorized('Invalid or expired challenge');
    }
    this.challenges.delete(id);
    return c;
  }

  rpId(projectId) {
    // rely on the configured public origin for the project, else request host
    return this.ctx.config.get('server.publicOrigin') || null;
  }

  passkeyRegisterChallenge(projectId, userId) {
    const c = this._storeChallenge(projectId, 'passkey_register', userId);
    const existing = this.db.all('SELECT credential_id FROM user_passkeys WHERE user_id = ?', [userId]);
    return {
      challengeId: c.id,
      challenge: c.challenge,
      rp: { name: 'Bloop', id: this.rpId(projectId) || undefined },
      user: { id: userId },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 120_000,
      excludeCredentials: existing.map((e) => ({ type: 'public-key', id: e.credential_id })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      attestation: 'none',
    };
  }

  passkeyRegisterVerify(projectId, userId, { challengeId, credential }) {
    const challenge = this._takeChallenge(challengeId, 'passkey_register', projectId);
    const clientData = JSON.parse(Buffer.from(credential.response.clientDataJSON, 'base64url').toString('utf8'));
    if (clientData.challenge !== challenge.challenge) throw unauthorized('Challenge mismatch');
    if (clientData.type !== 'webauthn.create') throw unauthorized('clientDataJSON type mismatch');
    // attestationObject is CBOR: { fmt, attStmt, authData }
    const attObj = cborDecode(Buffer.from(credential.response.attestationObject, 'base64url'));
    const parsedAuth = parseAuthData(attObj.authData instanceof Buffer ? attObj.authData : Buffer.from(attObj.authData));
    if (!(parsedAuth.flags & 0x01)) throw unauthorized('Authenticator did not assert user presence');
    const publicKey = coseKeyToObject(parsedAuth.attested.coseKey);
    this.db.run(
      'INSERT INTO user_passkeys (id, project_id, user_id, credential_id, public_key_cose, sign_count, transports, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [crypto.randomUUID(), projectId, userId, Buffer.from(parsedAuth.attested.credentialId).toString('base64url'),
        JSON.stringify(parsedAuth.attested.coseKey, (k, v) => (typeof v === 'bigint' ? v.toString() : v)),
        parsedAuth.signCount, JSON.stringify([]), new Date().toISOString()]
    );
    this._authLog(projectId, 'passkey_registered', { userId });
    return { registered: true, credentialId: Buffer.from(parsedAuth.attested.credentialId).toString('base64url') };
  }

  passkeyLoginChallenge(projectId, { email = null } = {}) {
    let allowCredentials = [];
    if (email) {
      const user = this.db.get('SELECT id FROM users WHERE project_id = ? AND email = ?', [projectId, String(email).toLowerCase()]);
      if (user) {
        allowCredentials = this.db.all('SELECT credential_id FROM user_passkeys WHERE user_id = ?', [user.id])
          .map((r) => ({ type: 'public-key', id: r.credential_id }));
      }
    }
    const c = this._storeChallenge(projectId, 'passkey_login');
    return {
      challengeId: c.id,
      challenge: c.challenge,
      rpId: this.rpId(projectId) || undefined,
      allowCredentials,
      timeout: 120_000,
      userVerification: 'preferred',
    };
  }

  passkeyLoginVerify(projectId, { challengeId, credential }, req) {
    const challenge = this._takeChallenge(challengeId, 'passkey_login', projectId);
    const clientData = JSON.parse(Buffer.from(credential.response.clientDataJSON, 'base64url').toString('utf8'));
    if (clientData.challenge !== challenge.challenge) throw unauthorized('Challenge mismatch');
    if (clientData.type !== 'webauthn.get') throw unauthorized('clientDataJSON type mismatch');
    const credId = credential.rawId || credential.id;
    const row = this.db.get('SELECT * FROM user_passkeys WHERE credential_id = ?', [credId]);
    if (!row || row.project_id !== projectId) throw unauthorized('Unknown passkey');
    const attObj = cborDecode(Buffer.from(credential.response.authenticatorData, 'base64url'));
    const authDataBuf = Buffer.from(credential.response.authenticatorData, 'base64url');
    const parsed = parseAuthData(attObj && attObj.authData ? Buffer.from(attObj.authData) : authDataBuf);
    if (!(parsed.flags & 0x01)) throw unauthorized('User presence flag missing');
    const publicKey = coseKeyToObject(JSON.parse(row.public_key_cose.toString ? row.public_key_cose.toString() : row.public_key_cose));
    const clientHash = crypto.createHash('sha256').update(Buffer.from(credential.response.clientDataJSON, 'base64url')).digest();
    const signed = Buffer.concat([authDataBuf, clientHash]);
    const sig = Buffer.from(credential.response.signature, 'base64url');
    if (!verifyEs256(publicKey, signed, sig)) throw unauthorized('Passkey signature verification failed');
    if (parsed.signCount > 0 && parsed.signCount <= row.sign_count && row.sign_count > 0) {
      throw unauthorized('Passkey signature counter did not increase — possible cloned credential');
    }
    this.db.run('UPDATE user_passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?', [parsed.signCount, new Date().toISOString(), row.id]);
    const user = this.db.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [row.user_id]);
    if (!user || user.disabled) throw forbidden('Account unavailable');
    this._authLog(projectId, 'passkey_login', { userId: user.id, req });
    return this._finishLogin(projectId, user, req);
  }

  listPasskeys(projectId, userId) {
    return this.db.all('SELECT id, credential_id, sign_count, created_at, last_used_at FROM user_passkeys WHERE project_id = ? AND user_id = ?', [projectId, userId]);
  }

  deletePasskey(projectId, userId, passkeyId) {
    const row = this.db.get('SELECT id FROM user_passkeys WHERE id = ? AND user_id = ? AND project_id = ?', [passkeyId, userId, projectId]);
    if (!row) throw notFound('Passkey not found');
    this.db.run('DELETE FROM user_passkeys WHERE id = ?', [passkeyId]);
    return { deleted: true };
  }

  // ── Admin user management ─────────────────────────────────────────────────
  adminListUsers(projectId, { limit = 50, offset = 0, search = null } = {}) {
    const rows = search
      ? this.db.all("SELECT * FROM users WHERE project_id = ? AND email LIKE ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?", [projectId, `%${search}%`, limit, offset])
      : this.db.all('SELECT * FROM users WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?', [projectId, limit, offset]);
    const total = this.db.get('SELECT COUNT(*) AS c FROM users WHERE project_id = ? AND deleted_at IS NULL', [projectId])?.c || 0;
    return { users: rows.map((u) => this.publicUser(u)), total };
  }

  adminCreateUser(projectId, input) {
    const data = validateOrThrow({
      email: { type: 'email', required: true },
      password: { type: 'string', required: true, min: 8 },
      emailVerified: { type: 'boolean', default: false },
      claims: { type: 'object' },
    }, input);
    const clash = this.db.get('SELECT id FROM users WHERE project_id = ? AND email = ?', [projectId, data.email.toLowerCase()]);
    if (clash) throw conflict('User already exists');
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO users (id, project_id, email, password_hash, email_verified, claims_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [id, projectId, data.email.toLowerCase(), hashPassword(data.password), data.emailVerified ? 1 : 0, JSON.stringify(data.claims || {}), now, now]
    );
    return this.publicUser(this.db.get('SELECT * FROM users WHERE id = ?', [id]));
  }

  adminUpdateUser(projectId, userId, patch) {
    const user = this.db.get('SELECT * FROM users WHERE id = ? AND project_id = ?', [userId, projectId]);
    if (!user) throw notFound('User not found');
    const data = validateOrThrow({
      disabled: { type: 'boolean' },
      emailVerified: { type: 'boolean' },
      claims: { type: 'object' },
      metadata: { type: 'object' },
    }, patch);
    if (data.disabled !== undefined) this.db.run('UPDATE users SET disabled = ? WHERE id = ?', [data.disabled ? 1 : 0, userId]);
    if (data.emailVerified !== undefined) this.db.run('UPDATE users SET email_verified = ? WHERE id = ?', [data.emailVerified ? 1 : 0, userId]);
    if (data.claims !== undefined) this.db.run('UPDATE users SET claims_json = ? WHERE id = ?', [JSON.stringify(data.claims), userId]);
    if (data.metadata !== undefined) this.db.run('UPDATE users SET metadata_json = ? WHERE id = ?', [JSON.stringify(data.metadata), userId]);
    if (data.disabled) this.revokeAllSessions(projectId, userId);
    return this.publicUser(this.db.get('SELECT * FROM users WHERE id = ?', [userId]));
  }

  adminDeleteUser(projectId, userId, { purge = false } = {}) {
    const user = this.db.get('SELECT * FROM users WHERE id = ? AND project_id = ?', [userId, projectId]);
    if (!user) throw notFound('User not found');
    this.revokeAllSessions(projectId, userId);
    if (purge) {
      this.db.run('DELETE FROM users WHERE id = ?', [userId]);
      this.db.run('DELETE FROM user_identities WHERE user_id = ?', [userId]);
      this.db.run('DELETE FROM user_passkeys WHERE user_id = ?', [userId]);
      this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    } else {
      this.db.run('UPDATE users SET deleted_at = ?, disabled = 1 WHERE id = ?', [new Date().toISOString(), userId]);
    }
    this._authLog(projectId, 'user_deleted', { userId, detail: { purge } });
    return { deleted: true, purged: !!purge };
  }

  adminAuthLogs(projectId, { limit = 100, event = null } = {}) {
    const rows = event
      ? this.db.all('SELECT * FROM auth_logs WHERE project_id = ? AND event = ? ORDER BY ts DESC LIMIT ?', [projectId, event, limit])
      : this.db.all('SELECT * FROM auth_logs WHERE project_id = ? ORDER BY ts DESC LIMIT ?', [projectId, limit]);
    return rows;
  }
}

export async function register(ctx) {
  ctx.authentication = new Authentication(ctx);
}

// ═══ Routes ═══════════════════════════════════════════════════════════════════
export function mountRoutes(ctx) {
  const r = ctx.router;
  const A = () => ctx.authentication;
  const PROJECT_AUTH = { auth: 'project' };

  r.post('/api/v1/:projectId/auth/register', async (req, res) => {
    res.json(200, await A().register(req.params.projectId, req.body, req));
  }, { auth: 'public', rateLimit: { max: 10, windowMs: 60_000 } });

  r.post('/api/v1/:projectId/auth/login', async (req, res) => {
    res.json(200, await A().login(req.params.projectId, req.body, req));
  }, { auth: 'public', rateLimit: { max: 10, windowMs: 60_000 } });

  r.post('/api/v1/:projectId/auth/mfa/verify', async (req, res) => {
    const { mfaToken, code } = req.body || {};
    if (!mfaToken || !code) throw badRequest('mfaToken and code are required');
    res.json(200, await A().loginMfa(req.params.projectId, mfaToken, code, req));
  }, { auth: 'public', rateLimit: { max: 10, windowMs: 60_000 } });

  r.post('/api/v1/:projectId/auth/refresh', async (req, res) => {
    res.json(200, await A().refresh(req.params.projectId, req.body?.refreshToken, req));
  }, { auth: 'public' });

  r.post('/api/v1/:projectId/auth/logout', async (req, res) => {
    res.json(200, A().logout(req.params.projectId, req.body?.refreshToken));
  }, { auth: 'public' });

  r.post('/api/v1/:projectId/auth/verify-email', async (req, res) => {
    res.json(200, A().verifyEmail(req.params.projectId, req.body?.token));
  }, { auth: 'public' });

  r.post('/api/v1/:projectId/auth/password-reset', async (req, res) => {
    res.json(200, await A().requestPasswordReset(req.params.projectId, req.body?.email, req));
  }, { auth: 'public', rateLimit: { max: 5, windowMs: 60_000 } });

  r.post('/api/v1/:projectId/auth/password-reset/confirm', async (req, res) => {
    res.json(200, await A().resetPassword(req.params.projectId, req.body?.token, req.body?.password));
  }, { auth: 'public' });

  r.get('/api/v1/:projectId/auth/me', async (req, res) => {
    res.json(200, A().me(req.params.projectId, req.principal.userId));
  }, { auth: 'project' });

  r.patch('/api/v1/:projectId/auth/me', async (req, res) => {
    res.json(200, A().updateProfile(req.params.projectId, req.principal.userId, req.body || {}));
  }, { auth: 'project' });

  r.post('/api/v1/:projectId/auth/me/delete', async (req, res) => {
    res.json(200, await A().deleteAccount(req.params.projectId, req.principal.userId));
  }, { auth: 'project' });

  r.post('/api/v1/:projectId/auth/me/password', async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    res.json(200, A().changePassword(req.params.projectId, req.principal.userId, currentPassword, newPassword));
  }, { auth: 'project' });

  r.post('/api/v1/:projectId/auth/totp/enroll', async (req, res) => {
    res.json(200, A().totpEnroll(req.params.projectId, req.principal.userId));
  }, { auth: 'project' });

  r.post('/api/v1/:projectId/auth/totp/enable', async (req, res) => {
    res.json(200, A().totpEnable(req.params.projectId, req.principal.userId, req.body?.code));
  }, { auth: 'project' });

  r.post('/api/v1/:projectId/auth/totp/disable', async (req, res) => {
    res.json(200, A().totpDisable(req.params.projectId, req.principal.userId, req.body?.password));
  }, { auth: 'project' });

  r.get('/api/v1/:projectId/auth/passkeys', async (req, res) => {
    res.json(200, { passkeys: A().listPasskeys(req.params.projectId, req.principal.userId) });
  }, { auth: 'project' });

  r.post('/api/v1/:projectId/auth/passkeys/register-challenge', async (req, res) => {
    res.json(200, A().passkeyRegisterChallenge(req.params.projectId, req.principal.userId));
  }, { auth: 'project' });

  r.post('/api/v1/:projectId/auth/passkeys/register', async (req, res) => {
    res.json(200, A().passkeyRegisterVerify(req.params.projectId, req.principal.userId, req.body || {}));
  }, { auth: 'project' });

  r.post('/api/v1/:projectId/auth/passkeys/login-challenge', async (req, res) => {
    res.json(200, A().passkeyLoginChallenge(req.params.projectId, req.body || {}));
  }, { auth: 'public' });

  r.post('/api/v1/:projectId/auth/passkeys/login', async (req, res) => {
    res.json(200, await A().passkeyLoginVerify(req.params.projectId, req.body || {}, req));
  }, { auth: 'public' });

  r.get('/api/v1/:projectId/auth/sessions', async (req, res) => {
    res.json(200, { sessions: A().listSessions(req.params.projectId, req.principal.userId) });
  }, { auth: 'project' });

  r.delete('/api/v1/:projectId/auth/sessions/:sessionId', async (req, res) => {
    res.json(200, A().revokeSession(req.params.projectId, req.principal.userId, req.params.sessionId));
  }, { auth: 'project' });

  r.post('/api/v1/:projectId/auth/sessions/revoke-all', async (req, res) => {
    res.json(200, A().revokeAllSessions(req.params.projectId, req.principal.userId));
  }, { auth: 'project' });
}
