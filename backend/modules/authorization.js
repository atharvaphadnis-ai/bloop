// modules/authorization.js — project-level principal resolution (API keys,
// user JWTs, anon keys), scope enforcement and per-key rate limiting.
import crypto from 'node:crypto';
import { badRequest, unauthorized, forbidden } from '../core/error-handler.js';

export class Authorization {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'authorization' });
  }

  get db() { return this.ctx.system; }

  extractCredentials(req) {
    const authHeader = String(req.headers.authorization || '');
    if (authHeader.toLowerCase().startsWith('bearer ')) {
      return authHeader.slice(7).trim();
    }
    if (authHeader.toLowerCase().startsWith('apikey ')) {
      return authHeader.slice(7).trim();
    }
    if (req.headers['x-bloop-key']) return String(req.headers['x-bloop-key']).trim();
    if (req.query?.apikey) return String(req.query.apikey).trim();
    return null;
  }

  async resolveProjectPrincipal(req) {
    const projectId = req.params?.projectId;
    if (!projectId) return null;
    const credential = this.extractCredentials(req);
    if (!credential) return null;

    // ── API keys (bk_*) ────────────────────────────────────────────────────
    if (credential.startsWith('bk_')) {
      const hash = crypto.createHash('sha256').update(credential).digest('hex');
      const key = this.db.get('SELECT * FROM api_keys WHERE key_hash = ?', [hash]);
      if (!key || key.revoked) throw unauthorized('API key is invalid or revoked');
      if (key.project_id !== projectId) throw forbidden('API key does not belong to this project');
      try { this.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [new Date().toISOString(), key.id]); } catch { }
      const scopes = JSON.parse(key.scopes_json || '[]');
      const isService = key.key_type === 'service';
      // per-key rate limit
      const rl = this.ctx.config.get('security.rateLimit', { max: 600, windowMs: 60000 });
      const result = this.ctx.rateLimiter.check(`apikey:${key.id}`, rl);
      if (!result.allowed) throw Object.assign(badRequest('API key rate limit exceeded'), { status: 429, code: 'RATE_LIMITED', retryAfter: Math.ceil(result.retryAfterMs / 1000) });
      return {
        type: 'apikey',
        apiKeyId: key.id,
        apiKeyType: key.key_type,
        projectId,
        scopes,
        role: isService ? 'service' : 'apikey',
        bypassRls: isService,
        rateLimitKey: `apikey:${key.id}`,
      };
    }

    // ── User access token (project-issued JWT) ─────────────────────────────
    const verified = this.ctx.authentication.verifyAccessToken(projectId, credential);
    if (!verified) throw unauthorized('Access token is invalid or expired — refresh it');
    const user = this.db.get('SELECT * FROM users WHERE id = ?', [verified.payload.sub]);
    if (!user || user.disabled || user.deleted_at) throw forbidden('Account unavailable');
    return {
      type: 'user',
      userId: user.id,
      projectId,
      email: user.email,
      role: 'authenticated',
      claims: JSON.parse(user.claims_json || '{}'),
      bypassRls: false,
      sessionId: verified.session.id,
      rateLimitKey: `user:${user.id}`,
    };
  }

  scopeCheck(principal, domain, action) {
    if (principal.type === 'apikey') {
      if (!this.ctx.permissions.keyAllows(principal.scopes, domain, action)) {
        throw forbidden(`API key lacks scope ${domain}:${action}`);
      }
      return true;
    }
    if (principal.type === 'user') return true; // authenticated users are policy-gated (RLS), not scope-gated
    return true;
  }
}

export async function register(ctx) {
  ctx.authorization = new Authorization(ctx);
}
