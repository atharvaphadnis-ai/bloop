// infrastructure/oauth.js — configurable OAuth providers (Google, GitHub,
// Discord + generic OIDC). Client secrets are encrypted at rest and never
// returned by the API. The callback flow exchanges the code, fetches the
// profile and hands off to authentication.completeOAuth for account linking.
import crypto from 'node:crypto';
import { badRequest, notFound, unauthorized } from '../core/error-handler.js';
import { validateOrThrow } from '../core/validation.js';

export const OAUTH_PROVIDERS = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
    defaultScopes: ['openid', 'email', 'profile'],
    profile: async (accessToken) => {
      const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
      const p = await r.json();
      return { providerUserId: p.sub, email: p.email, emailVerified: p.email_verified === true, metadata: { name: p.name, picture: p.picture } };
    },
  },
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userinfo: null, // uses the API below
    defaultScopes: ['read:user', 'user:email'],
    profile: async (accessToken) => {
      const r = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' } });
      const p = await r.json();
      let email = p.email, emailVerified = false;
      const er = await fetch('https://api.github.com/user/emails', { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' } });
      if (er.ok) {
        const emails = await er.json();
        const primary = emails.find((e) => e.primary) || emails[0];
        if (primary) { email = primary.email; emailVerified = primary.verified; }
      }
      return { providerUserId: String(p.id), email, emailVerified, metadata: { login: p.login, name: p.name, avatar: p.avatar_url } };
    },
  },
  discord: {
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    userinfo: 'https://discord.com/api/users/@me',
    defaultScopes: ['identify', 'email'],
    profile: async (accessToken) => {
      const r = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } });
      const p = await r.json();
      return { providerUserId: p.id, email: p.email, emailVerified: p.verified === true, metadata: { username: p.username, avatar: p.avatar } };
    },
  },
};

export class OAuthService {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'oauth' });
    this.states = new Map(); // state -> {projectId, provider, expiresAt}
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.states) if (v.expiresAt < now) this.states.delete(k);
    }, 60_000).unref?.();
  }

  get db() { return this.ctx.system; }

  listConfigs(projectId) {
    return this.db.all('SELECT id, provider, client_id, redirect_url, scopes, enabled, created_at, updated_at FROM oauth_configs WHERE project_id = ? ORDER BY provider', [projectId])
      .map((c) => ({ ...c, enabled: !!c.enabled, client_secret: '••••••••', hasSecret: true }));
  }

  async saveConfig(projectId, input) {
    const data = validateOrThrow({
      provider: { type: 'string', required: true, max: 60 },
      clientId: { type: 'string', required: true, max: 300 },
      clientSecret: { type: 'string', max: 500 },
      redirectUrl: { type: 'string', max: 500 },
      scopes: { type: 'string', max: 500 },
      enabled: { type: 'boolean', default: true },
    }, input);
    const known = OAUTH_PROVIDERS[data.provider];
    if (!known && !data.redirectUrl) {
      // generic providers must fully declare their endpoints
      throw badRequest('Unknown provider — supply a supported provider (google, github, discord) or configure endpoints via the generic OIDC setup in docs/authentication.md');
    }
    const existing = this.db.get('SELECT * FROM oauth_configs WHERE project_id = ? AND provider = ?', [projectId, data.provider]);
    const now = new Date().toISOString();
    const secretEnc = data.clientSecret ? this.ctx.security.encrypt(data.clientSecret) : existing?.client_secret_encrypted || null;
    if (existing) {
      this.db.run(
        'UPDATE oauth_configs SET client_id = ?, client_secret_encrypted = ?, redirect_url = ?, scopes = ?, enabled = ?, updated_at = ? WHERE id = ?',
        [data.clientId, secretEnc, data.redirectUrl || existing.redirect_url, data.scopes || known?.defaultScopes.join(' ') || existing.scopes, data.enabled ? 1 : 0, now, existing.id]
      );
    } else {
      this.db.run(
        'INSERT INTO oauth_configs (id, project_id, provider, client_id, client_secret_encrypted, redirect_url, scopes, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [crypto.randomUUID(), projectId, data.provider, data.clientId, secretEnc, data.redirectUrl || null,
          data.scopes || known?.defaultScopes.join(' ') || '', data.enabled ? 1 : 0, now, now]
      );
    }
    this.ctx.audit?.record({ actor: 'system', action: 'oauth.config.save', projectId, target: data.provider });
    return { provider: data.provider, enabled: data.enabled };
  }

  getConfig(projectId, provider) {
    const row = this.db.get('SELECT * FROM oauth_configs WHERE project_id = ? AND provider = ? AND enabled = 1', [projectId, provider]);
    if (!row) throw notFound(`OAuth provider "${provider}" is not configured (or disabled) for this project`);
    return row;
  }

  deleteConfig(projectId, provider) {
    const row = this.db.get('SELECT * FROM oauth_configs WHERE project_id = ? AND provider = ?', [projectId, provider]);
    if (!row) throw notFound('OAuth config not found');
    this.db.run('DELETE FROM oauth_configs WHERE id = ?', [row.id]);
    return { deleted: true };
  }

  buildStartUrl(req, projectId, provider, config) {
    const spec = OAUTH_PROVIDERS[provider];
    const base = this.ctx.config.get('server.publicOrigin') || `http://${req.headers.host || 'localhost:8090'}`;
    const redirect = config.redirect_url || `${base}/api/v1/${projectId}/auth/oauth/${provider}/callback`;
    const state = crypto.randomBytes(20).toString('base64url');
    this.states.set(state, { projectId, provider, expiresAt: Date.now() + 10 * 60_000 });
    const url = new URL(spec.authorizeUrl);
    url.searchParams.set('client_id', config.client_id);
    url.searchParams.set('redirect_uri', redirect);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', config.scopes || spec.defaultScopes.join(' '));
    url.searchParams.set('state', state);
    if (provider === 'google') { url.searchParams.set('access_type', 'offline'); url.searchParams.set('prompt', 'select_account'); }
    return { url: url.toString(), redirect, state };
  }

  async handleCallback(req, projectId, provider, { code, state }) {
    const stateData = this.states.get(state);
    if (!stateData || stateData.projectId !== projectId || stateData.provider !== provider) {
      throw unauthorized('Invalid OAuth state — possible CSRF, restart the sign-in flow');
    }
    this.states.delete(state);
    const config = this.getConfig(projectId, provider);
    const spec = OAUTH_PROVIDERS[provider];
    if (!spec) throw badRequest(`Provider "${provider}" cannot complete callbacks in this deployment (generic OIDC: use the documented endpoint configuration)`);
    const base = this.ctx.config.get('server.publicOrigin') || `http://${req.headers.host || 'localhost:8090'}`;
    const redirect = config.redirect_url || `${base}/api/v1/${projectId}/auth/oauth/${provider}/callback`;

    const tokenRes = await fetch(spec.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: config.client_id,
        client_secret: this.ctx.security.decrypt(config.client_secret_encrypted),
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirect,
      }),
    });
    if (!tokenRes.ok) {
      throw unauthorized(`Token exchange failed: ${(await tokenRes.text()).slice(0, 300)}`);
    }
    const tokens = await tokenRes.json();
    const profile = await spec.profile(tokens.access_token);
    if (!profile.email) {
      throw badRequest(`The provider did not return an email address (scope "${config.scopes}" may be insufficient)`);
    }
    const result = await this.ctx.authentication.completeOAuth(projectId, {
      provider, providerUserId: profile.providerUserId, email: profile.email,
      emailVerified: profile.emailVerified, metadata: profile.metadata,
    }, req);
    return result;
  }

  // admin test: verify the provider endpoint is reachable (no token exchange)
  async testProvider(projectId, provider) {
    const spec = OAUTH_PROVIDERS[provider];
    if (!spec) return { ok: false, error: `Unknown provider "${provider}"` };
    try {
      const r = await fetch(spec.authorizeUrl, { method: 'HEAD' });
      return { ok: true, status: r.status, authorizeUrl: spec.authorizeUrl };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

export async function register(ctx) {
  ctx.oauth = new OAuthService(ctx);
}

export function mountRoutes(ctx) {
  ctx.router.get('/api/v1/:projectId/auth/oauth/:provider/start', async (req, res) => {
    const config = ctx.oauth.getConfig(req.params.projectId, req.params.provider);
    const { url, redirect } = ctx.oauth.buildStartUrl(req, req.params.projectId, req.params.provider, config);
    res.json(200, { url, redirect });
  }, { auth: 'public' });

  ctx.router.get('/api/v1/:projectId/auth/oauth/:provider/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) throw badRequest(`OAuth provider error: ${error}`);
    if (!code || !state) throw badRequest('Missing code/state in OAuth callback');
    const result = await ctx.oauth.handleCallback(req, req.params.projectId, req.params.provider, { code, state });
    res.json(200, result);
  }, { auth: 'public' });
}
