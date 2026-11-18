// infrastructure/admin-api.js — the complete dashboard API. Every admin route
// requires a dashboard session (Bearer JWT from /api/admin/login) unless the
// route opts into 'public'. Secrets are masked in responses; revealing the
// service key is an audited operation.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { badRequest, notFound, forbidden, unauthorized, conflict } from '../core/error-handler.js';
import { validateOrThrow } from '../core/validation.js';
import { hashPassword, verifyPassword, generateTotpSecret, verifyTotp, totpUrl } from '../modules/authentication.js';

const ADMIN_SESSION_TTL_SEC = 60 * 60 * 12; // 12h — long dashboard sessions, fewer surprise logins
const ADMIN_REFRESH_TTL_SEC = 30 * 86400;

function perm(req, permission) {
  if (!req.admin) throw unauthorized();
  if (!ctxPermissions(req).can(req.admin, permission)) {
    throw forbidden(`Your role (${req.admin.role}) lacks permission "${permission}"`);
  }
}
function ctxPermissions(req) {
  return req.app?.permissions || globalThis.__bloopPermissions;
}

export function mountRoutes(ctx) {
  const r = ctx.router;
  const A = { auth: 'admin' };
  globalThis.__bloopPermissions = ctx.permissions;

  // ═══ Bootstrap & dashboard authentication ═══════════════════════════════
  r.get('/api/admin/bootstrap', async (req, res) => {
    const count = ctx.system.get('SELECT COUNT(*) AS c FROM admin_users')?.c || 0;
    res.json(200, {
      setupRequired: count === 0,
      version: ctx.version,
      platform: ctx.security.settingsGet('platform', 'name', 'Bloop'),
      tagline: ctx.security.settingsGet('platform', 'tagline', 'Your backend. Your rules. Your database.'),
    });
  }, { auth: 'public' });

  r.post('/api/admin/setup', async (req, res) => {
    const count = ctx.system.get('SELECT COUNT(*) AS c FROM admin_users')?.c || 0;
    if (count > 0) throw badRequest('Setup is already complete — sign in instead');
    const data = validateOrThrow({
      email: { type: 'email', required: true },
      password: { type: 'string', required: true, min: 10, max: 200 },
      name: { type: 'string', max: 100 },
    }, req.body || {});
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    ctx.system.run(
      "INSERT INTO admin_users (id, email, name, password_hash, role, created_at) VALUES (?,?,?,?, 'owner', ?)",
      [id, data.email.toLowerCase(), data.name || 'Owner', hashPassword(data.password), now]
    );
    const orgId = await ctx.tenants.ensureDefaultOrganization();
    ctx.system.run('INSERT OR IGNORE INTO org_members (org_id, user_id, role, created_at) VALUES (?,?,?,?)',
      [orgId, id, 'owner', now]);
    ctx.audit?.record({ actor: data.email, action: 'admin.setup', target: id });
    const session = await createAdminSession(ctx, req, ctx.system.get('SELECT * FROM admin_users WHERE id = ?', [id]));
    res.json(200, session);
  }, { auth: 'public' });

  r.post('/api/admin/login', async (req, res) => {
    const data = validateOrThrow({
      email: { type: 'email', required: true },
      password: { type: 'string', required: true },
      totpCode: { type: 'string', max: 10 },
    }, req.body || {});
    const lockKey = `admin:${req.ip}:${data.email.toLowerCase()}`;
    const lock = ctx.bruteForce.status(lockKey);
    if (lock.locked) throw unauthorized(`Too many attempts — locked for ${Math.ceil(lock.retryAfterMs / 1000)}s`);
    const admin = ctx.system.get('SELECT * FROM admin_users WHERE email = ?', [data.email.toLowerCase()]);
    if (!admin || admin.disabled || !verifyPassword(data.password, admin.password_hash)) {
      ctx.bruteForce.failure(lockKey);
      ctx.audit?.record({ actor: data.email, action: 'admin.login_failed', ip: req.ip });
      throw unauthorized('Invalid email or password');
    }
    if (admin.totp_enabled) {
      if (!data.totpCode) {
        return res.json(200, { mfaRequired: true });
      }
      if (!verifyTotp(admin.totp_secret, data.totpCode)) {
        ctx.bruteForce.failure(lockKey);
        throw unauthorized('Invalid authentication code');
      }
    }
    ctx.bruteForce.success(lockKey);
    ctx.system.run('UPDATE admin_users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), admin.id]);
    ctx.audit?.record({ actor: admin.email, action: 'admin.login', ip: req.ip });
    const session = await createAdminSession(ctx, req, admin);
    res.json(200, session);
  }, { auth: 'public' });

  r.post('/api/admin/refresh', async (req, res) => {
    const hash = ctx.security.sha256(String(req.body?.refreshToken || ''));
    const session = ctx.system.get('SELECT * FROM admin_sessions WHERE refresh_hash = ? AND revoked = 0', [hash]);
    if (!session || session.expires_at < new Date().toISOString()) throw unauthorized('Invalid refresh token');
    const admin = ctx.system.get('SELECT * FROM admin_users WHERE id = ?', [session.user_id]);
    if (!admin || admin.disabled) throw unauthorized('Account unavailable');
    const newRefresh = ctx.security.randomToken(32);
    ctx.system.run('UPDATE admin_sessions SET refresh_hash = ?, expires_at = ? WHERE id = ?',
      [ctx.security.sha256(newRefresh), new Date(Date.now() + ADMIN_REFRESH_TTL_SEC * 1000).toISOString(), session.id]);
    res.json(200, {
      accessToken: ctx.security.signAdminJwt({ sub: admin.id, email: admin.email, role: admin.role, sid: session.id }, ADMIN_SESSION_TTL_SEC),
      refreshToken: newRefresh,
      admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
    });
  }, { auth: 'public' });

  r.post('/api/admin/logout', async (req, res) => {
    const hash = ctx.security.sha256(String(req.body?.refreshToken || ''));
    ctx.system.run('UPDATE admin_sessions SET revoked = 1 WHERE refresh_hash = ?', [hash]);
    if (req.admin) ctx.system.run('UPDATE admin_sessions SET revoked = 1 WHERE id = ?', [req.admin.sessionId]);
    res.json(200, { loggedOut: true });
  }, { auth: 'public' });

  r.get('/api/admin/me', async (req, res) => {
    const admin = ctx.system.get('SELECT id, email, name, role, totp_enabled, created_at, last_login_at FROM admin_users WHERE id = ?', [req.admin.id]);
    res.json(200, { admin, orgs: ctx.tenants.orgsForUser(req.admin.id), permissions: ctx.permissions.can(req.admin, '*') ? ['*'] : undefined });
  }, A);

  r.post('/api/admin/me/password', async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const admin = ctx.system.get('SELECT * FROM admin_users WHERE id = ?', [req.admin.id]);
    if (!verifyPassword(currentPassword || '', admin.password_hash)) throw unauthorized('Current password is incorrect');
    if (!newPassword || String(newPassword).length < 10) throw badRequest('New password must be at least 10 characters');
    ctx.system.run('UPDATE admin_users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), admin.id]);
    ctx.audit?.record({ actor: req.admin.email, action: 'admin.password_changed' });
    res.json(200, { changed: true });
  }, A);

  r.post('/api/admin/me/totp/enroll', async (req, res) => {
    const secret = generateTotpSecret();
    ctx.system.run('UPDATE admin_users SET totp_secret = ? WHERE id = ?', [secret, req.admin.id]);
    res.json(200, { secret, otpauthUrl: totpUrl(secret, req.admin.email, 'Bloop Dashboard') });
  }, A);
  r.post('/api/admin/me/totp/enable', async (req, res) => {
    const admin = ctx.system.get('SELECT * FROM admin_users WHERE id = ?', [req.admin.id]);
    if (!verifyTotp(admin.totp_secret, req.body?.code)) throw badRequest('Invalid code');
    ctx.system.run('UPDATE admin_users SET totp_enabled = 1 WHERE id = ?', [admin.id]);
    res.json(200, { enabled: true });
  }, A);
  r.post('/api/admin/me/totp/disable', async (req, res) => {
    const admin = ctx.system.get('SELECT * FROM admin_users WHERE id = ?', [req.admin.id]);
    if (!verifyPassword(req.body?.password || '', admin.password_hash)) throw unauthorized('Password incorrect');
    ctx.system.run('UPDATE admin_users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', [admin.id]);
    res.json(200, { disabled: true });
  }, A);

  // ═══ Organizations / members / invitations ══════════════════════════════
  r.get('/api/admin/orgs', async (req, res) => res.json(200, { orgs: ctx.tenants.orgsForUser(req.admin.id) }), A);
  r.post('/api/admin/orgs', async (req, res) => {
    perm(req, 'org.write');
    const org = ctx.tenants.createOrg(req.body || {});
    ctx.system.run('INSERT OR IGNORE INTO org_members (org_id, user_id, role, created_at) VALUES (?,?,?,?)',
      [org.id, req.admin.id, 'owner', new Date().toISOString()]);
    res.json(200, org);
  }, A);
  r.get('/api/admin/orgs/:id', async (req, res) => {
    ctx.tenants.requireMembership(req.admin.id, req.params.id);
    res.json(200, ctx.tenants.getOrg(req.params.id));
  }, A);
  r.patch('/api/admin/orgs/:id', async (req, res) => {
    perm(req, 'org.write');
    ctx.tenants.requireMembership(req.admin.id, req.params.id);
    res.json(200, ctx.tenants.updateOrg(req.params.id, req.body || {}));
  }, A);
  r.get('/api/admin/orgs/:id/members', async (req, res) => {
    ctx.tenants.requireMembership(req.admin.id, req.params.id);
    res.json(200, { members: ctx.tenants.listMembers(req.params.id) });
  }, A);
  r.post('/api/admin/orgs/:id/members', async (req, res) => {
    perm(req, 'org.members');
    res.json(200, ctx.tenants.addMember(req.params.id, req.body || {}));
  }, A);
  r.patch('/api/admin/orgs/:id/members/:userId', async (req, res) => {
    perm(req, 'org.members');
    res.json(200, ctx.tenants.updateMember(req.params.id, req.params.userId, req.body || {}));
  }, A);
  r.delete('/api/admin/orgs/:id/members/:userId', async (req, res) => {
    perm(req, 'org.members');
    res.json(200, ctx.tenants.removeMember(req.params.id, req.params.userId));
  }, A);
  r.get('/api/admin/orgs/:id/invitations', async (req, res) => {
    perm(req, 'org.members');
    res.json(200, { invitations: ctx.tenants.listInvitations(req.params.id) });
  }, A);
  r.post('/api/admin/orgs/:id/invitations', async (req, res) => {
    perm(req, 'org.members');
    const inv = ctx.tenants.createInvitation(req.params.id, req.body || {}, { invitedBy: req.admin.email });
    res.json(200, inv);
  }, A);
  r.delete('/api/admin/orgs/:id/invitations/:inviteId', async (req, res) => {
    perm(req, 'org.members');
    res.json(200, ctx.tenants.revokeInvitation(req.params.id, req.params.inviteId));
  }, A);
  r.post('/api/admin/invitations/accept', async (req, res) => {
    res.json(200, ctx.tenants.acceptInvitation(req.body?.token, req.admin.id));
  }, A);

  // ═══ Projects ═══════════════════════════════════════════════════════════
  r.get('/api/admin/projects', async (req, res) => {
    const orgs = ctx.tenants.orgsForUser(req.admin.id);
    const projects = orgs.length
      ? orgs.flatMap((o) => ctx.projects.list(o.id))
      : [];
    res.json(200, { projects, orgs });
  }, A);
  r.post('/api/admin/projects', async (req, res) => {
    perm(req, 'project.write');
    const orgId = req.body?.orgId || ctx.tenants.orgsForUser(req.admin.id)[0]?.id
      || (await ctx.tenants.ensureDefaultOrganization());
    ctx.tenants.requireMembership(req.admin.id, orgId);
    const project = await ctx.projects.create(orgId, req.body || {}, { actor: req.admin.email });
    res.json(200, project);
  }, A);
  r.get('/api/admin/projects/:id', async (req, res) => {
    const project = ctx.projects.get(req.params.id);
    ctx.tenants.requireMembership(req.admin.id, project.org_id);
    res.json(200, project);
  }, A);
  r.patch('/api/admin/projects/:id', async (req, res) => {
    perm(req, 'project.write');
    const project = ctx.projects.get(req.params.id);
    ctx.tenants.requireMembership(req.admin.id, project.org_id);
    res.json(200, ctx.projects.update(req.params.id, req.body || {}));
  }, A);
  r.post('/api/admin/projects/:id/delete', async (req, res) => {
    perm(req, 'project.delete');
    const project = ctx.projects.get(req.params.id);
    ctx.tenants.requireMembership(req.admin.id, project.org_id);
    res.json(200, await ctx.projects.delete(req.params.id, { confirm: req.body?.confirm === true }));
  }, A);
  r.post('/api/admin/projects/:id/duplicate', async (req, res) => {
    perm(req, 'project.write');
    const project = ctx.projects.get(req.params.id);
    ctx.tenants.requireMembership(req.admin.id, project.org_id);
    res.json(200, await ctx.projects.duplicate(req.params.id, req.body || {}));
  }, A);
  r.get('/api/admin/projects/:id/export', async (req, res) => {
    perm(req, 'project.read');
    const bundle = ctx.projects.exportProject(req.params.id);
    const body = JSON.stringify(bundle, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${project_export_name(bundle)}.json"`,
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }, A);
  r.post('/api/admin/projects/import', async (req, res) => {
    perm(req, 'project.write');
    const orgId = ctx.tenants.orgsForUser(req.admin.id)[0]?.id || (await ctx.tenants.ensureDefaultOrganization());
    res.json(200, await ctx.projects.importProject(orgId, req.body || {}, { actor: req.admin.email }));
  }, A);
  r.get('/api/admin/projects/:id/usage', async (req, res) => {
    perm(req, 'project.read');
    res.json(200, ctx.projects.usageStats(req.params.id, { days: Number(req.query.days || 30) }));
  }, A);

  r.get('/api/admin/startup-sound', async (req, res) => {
    // Which startup sound exists in frontend/assets/ (startup.mp3|.wav|.ogg)?
    // Always answers 200 so the browser console stays free of 404 noise when
    // the user has not dropped a file in yet.
    for (const ext of ['mp3', 'wav', 'ogg']) {
      if (fs.existsSync(path.join(ctx.rootDir, 'frontend', 'assets', `startup.${ext}`))) {
        return res.json(200, { src: `assets/startup.${ext}` });
      }
    }
    res.json(200, { src: null });
  }, A);

  // ── Project API keys ──
  r.get('/api/admin/projects/:id/keys', async (req, res) => {
    perm(req, 'project.read');
    res.json(200, { keys: ctx.projects.listApiKeys(req.params.id) });
  }, A);
  r.post('/api/admin/projects/:id/keys', async (req, res) => {
    perm(req, 'project.write');
    res.json(200, ctx.projects.createApiKey(req.params.id, req.body || {}));
  }, A);
  r.post('/api/admin/projects/:id/keys/:keyId/revoke', async (req, res) => {
    perm(req, 'project.write');
    res.json(200, ctx.projects.revokeApiKey(req.params.id, req.params.keyId));
  }, A);
  r.get('/api/admin/projects/:id/keys/reveal', async (req, res) => {
    perm(req, 'settings.read');
    const stored = ctx.security.settingsGet(`project:${req.params.id}`, 'bootstrapKeys', null);
    if (!stored) throw notFound('Bootstrap keys not found for this project');
    ctx.audit?.record({ actor: req.admin.email, action: 'apikey.reveal', projectId: req.params.id, ip: req.ip });
    res.json(200, {
      anon: stored.anon,
      service: ctx.security.decrypt(stored.service),
      note: 'The service_role key bypasses row-level security — keep it server-side only.',
    });
  }, A);

  // ── Environments & variables ──
  r.get('/api/admin/projects/:id/environments', async (req, res) => {
    res.json(200, { environments: ctx.environments.list(req.params.id) });
  }, A);
  r.post('/api/admin/projects/:id/environments', async (req, res) => {
    perm(req, 'project.write');
    res.json(200, ctx.environments.create(req.params.id, req.body || {}));
  }, A);
  r.post('/api/admin/projects/:id/environments/:envId/clone', async (req, res) => {
    perm(req, 'project.write');
    res.json(200, ctx.environments.clone(req.params.id, req.params.envId, req.body || {}));
  }, A);
  r.post('/api/admin/projects/:id/environments/:envId/set-default', async (req, res) => {
    perm(req, 'project.write');
    res.json(200, ctx.environments.setDefault(req.params.id, req.params.envId));
  }, A);
  r.delete('/api/admin/projects/:id/environments/:envId', async (req, res) => {
    perm(req, 'project.write');
    res.json(200, ctx.environments.delete(req.params.id, req.params.envId));
  }, A);
  r.get('/api/admin/projects/:id/environments/:envId/vars', async (req, res) => {
    res.json(200, { vars: ctx.environments.listVars(req.params.id, req.params.envId) });
  }, A);
  r.put('/api/admin/projects/:id/environments/:envId/vars', async (req, res) => {
    perm(req, 'settings.write');
    res.json(200, ctx.environments.setVar(req.params.id, req.params.envId, req.body?.key, req.body?.value));
  }, A);
  r.delete('/api/admin/projects/:id/environments/:envId/vars/:key', async (req, res) => {
    perm(req, 'settings.write');
    res.json(200, ctx.environments.deleteVar(req.params.id, req.params.envId, req.params.key));
  }, A);

  // ═══ Database: providers & connections ══════════════════════════════════
  r.get('/api/admin/providers', async (req, res) => {
    res.json(200, await ctx.database.providersStatusAsync());
  }, A);
  r.get('/api/admin/projects/:id/connections', async (req, res) => {
    res.json(200, { connections: ctx.database.listConnections(req.params.id) });
  }, A);
  r.post('/api/admin/connections/test', async (req, res) => {
    const { provider, config } = req.body || {};
    res.json(200, await ctx.database.testConnection(provider, config || {}));
  }, A);
  r.post('/api/admin/projects/:id/connections', async (req, res) => {
    perm(req, 'db.admin');
    res.json(200, await ctx.database.createConnection(req.params.id, req.body || {}));
  }, A);
  r.get('/api/admin/connections/:id', async (req, res) => {
    res.json(200, ctx.database.getConnection(req.params.id));
  }, A);
  r.patch('/api/admin/connections/:id', async (req, res) => {
    perm(req, 'db.admin');
    res.json(200, await ctx.database.updateConnection(req.params.id, req.body || {}));
  }, A);
  r.delete('/api/admin/connections/:id', async (req, res) => {
    perm(req, 'db.admin');
    res.json(200, await ctx.database.deleteConnection(req.params.id));
  }, A);
  r.post('/api/admin/connections/:id/set-default', async (req, res) => {
    perm(req, 'db.admin');
    const conn = ctx.database.getConnection(req.params.id);
    res.json(200, await ctx.database.setDefaultConnection(conn.project_id, req.params.id));
  }, A);
  r.post('/api/admin/connections/:id/refresh', async (req, res) => {
    res.json(200, await ctx.database.refreshStatus(req.params.id));
  }, A);

  // ── Schema inspection & management ──
  r.get('/api/admin/connections/:id/schema', async (req, res) => {
    perm(req, 'db.read');
    res.json(200, { tables: await ctx.database.schemaInspect(req.params.id) });
  }, A);
  r.get('/api/admin/connections/:id/tables/:table/rows', async (req, res) => {
    perm(req, 'db.read');
    const adapter = await ctx.database.getAdapter(req.params.id);
    const conn = ctx.database.getConnection(req.params.id);
    const limit = Math.min(Number(req.query.limit || 50), 500);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    let whereSql = '';
    const params = [];
    if (req.query.search) {
      const columns = await adapter.listColumns(req.params.table);
      whereSql = ' WHERE ' + columns.map((c) => `CAST(${c.name} AS TEXT) LIKE ?`).join(' OR ');
      params.push(...columns.map(() => `%${req.query.search}%`));
    }
    const result = await adapter.query(`SELECT * FROM ${qIdent(conn.provider, req.params.table)}${whereSql} LIMIT ${limit} OFFSET ${offset}`, params);
    let total = null;
    try {
      const c = await adapter.query(`SELECT COUNT(*) AS c FROM ${qIdent(conn.provider, req.params.table)}${whereSql}`, params);
      total = Number(c.rows[0]?.c ?? 0);
    } catch { }
    res.json(200, { rows: result.rows, total, limit, offset });
  }, A);
  r.post('/api/admin/connections/:id/tables', async (req, res) => {
    perm(req, 'db.admin');
    const adapter = await ctx.database.getAdapter(req.params.id);
    const result = await adapter.createTable(req.body || {});
    const conn = ctx.database.getConnection(req.params.id);
    ctx.database.logActivity(conn.project_id, req.params.id, 'table.create', { name: req.body?.name });
    res.json(200, result);
  }, A);
  r.post('/api/admin/connections/:id/tables/:table/rename', async (req, res) => {
    perm(req, 'db.admin');
    const adapter = await ctx.database.getAdapter(req.params.id);
    res.json(200, await adapter.renameTable(req.params.table, req.body?.name));
  }, A);
  r.delete('/api/admin/connections/:id/tables/:table', async (req, res) => {
    perm(req, 'db.admin');
    if (req.body?.confirm !== true) throw badRequest('Table deletion requires confirm: true');
    const adapter = await ctx.database.getAdapter(req.params.id);
    res.json(200, await adapter.dropTable(req.params.table, { ifExists: true }));
  }, A);
  r.post('/api/admin/connections/:id/tables/:table/columns', async (req, res) => {
    perm(req, 'db.admin');
    const adapter = await ctx.database.getAdapter(req.params.id);
    res.json(200, await adapter.addColumn(req.params.table, req.body || {}));
  }, A);
  r.delete('/api/admin/connections/:id/tables/:table/columns/:column', async (req, res) => {
    perm(req, 'db.admin');
    const adapter = await ctx.database.getAdapter(req.params.id);
    res.json(200, await adapter.dropColumn(req.params.table, req.params.column));
  }, A);
  r.post('/api/admin/connections/:id/tables/:table/indexes', async (req, res) => {
    perm(req, 'db.admin');
    const adapter = await ctx.database.getAdapter(req.params.id);
    res.json(200, await adapter.createIndex(req.params.table, req.body || {}));
  }, A);
  r.delete('/api/admin/connections/:id/indexes/:name', async (req, res) => {
    perm(req, 'db.admin');
    const adapter = await ctx.database.getAdapter(req.params.id);
    res.json(200, await adapter.dropIndex(req.params.name, req.query.table));
  }, A);
  r.get('/api/admin/connections/:id/relationships', async (req, res) => {
    perm(req, 'db.read');
    const adapter = await ctx.database.getAdapter(req.params.id);
    const tables = await adapter.listTables();
    const relationships = [];
    for (const t of tables.slice(0, 60)) {
      const fks = await adapter.listForeignKeys(t.name).catch(() => []);
      for (const fk of fks) {
        relationships.push({
          fromTable: t.name,
          fromColumn: fk.column ?? fk.column_name,
          toTable: fk.referencesTable ?? fk.referenced_table_name,
          toColumn: fk.referencesColumn ?? fk.referenced_column_name,
          onDelete: fk.onDelete ?? fk.on_delete ?? null,
        });
      }
    }
    res.json(200, { relationships });
  }, A);

  // ── SQL Studio ──
  r.post('/api/admin/connections/:id/query', async (req, res) => {
    perm(req, 'db.write');
    const { sql, params, sessionId } = req.body || {};
    if (!sql) throw badRequest('sql is required');
    const conn = ctx.database.getConnection(req.params.id);
    res.json(200, await ctx.sqlEditor.execute(conn.project_id, req.params.id, sql, { params, sessionId, actor: req.admin.email }));
  }, A);
  r.post('/api/admin/connections/:id/explain', async (req, res) => {
    perm(req, 'db.read');
    const conn = ctx.database.getConnection(req.params.id);
    res.json(200, await ctx.sqlEditor.explain(conn.project_id, req.params.id, req.body?.sql));
  }, A);
  r.get('/api/admin/connections/:id/autocomplete', async (req, res) => {
    res.json(200, await ctx.sqlEditor.autocomplete(req.params.id));
  }, A);
  r.post('/api/admin/connections/:id/transactions/begin', async (req, res) => {
    perm(req, 'db.write');
    const conn = ctx.database.getConnection(req.params.id);
    res.json(200, await ctx.sqlEditor.beginSession(conn.project_id, req.params.id));
  }, A);
  r.post('/api/admin/transactions/:sessionId/commit', async (req, res) => {
    perm(req, 'db.write');
    res.json(200, await ctx.sqlEditor.commitSession(req.params.sessionId));
  }, A);
  r.post('/api/admin/transactions/:sessionId/rollback', async (req, res) => {
    perm(req, 'db.write');
    res.json(200, await ctx.sqlEditor.rollbackSession(req.params.sessionId));
  }, A);
  r.get('/api/admin/projects/:id/query-history', async (req, res) => {
    res.json(200, { history: ctx.sqlEditor.history(req.params.id, { connectionId: req.query.connectionId, limit: Number(req.query.limit || 50) }) });
  }, A);
  r.delete('/api/admin/projects/:id/query-history', async (req, res) => {
    res.json(200, ctx.sqlEditor.clearHistory(req.params.id));
  }, A);
  r.get('/api/admin/projects/:id/saved-queries', async (req, res) => {
    res.json(200, { queries: ctx.sqlEditor.listSavedQueries(req.params.id) });
  }, A);
  r.post('/api/admin/projects/:id/saved-queries', async (req, res) => {
    perm(req, 'db.write');
    res.json(200, ctx.sqlEditor.saveQuery(req.params.id, req.body || {}));
  }, A);
  r.patch('/api/admin/projects/:id/saved-queries/:queryId', async (req, res) => {
    perm(req, 'db.write');
    res.json(200, ctx.sqlEditor.updateSavedQuery(req.params.id, req.params.queryId, req.body || {}));
  }, A);
  r.delete('/api/admin/projects/:id/saved-queries/:queryId', async (req, res) => {
    perm(req, 'db.write');
    res.json(200, ctx.sqlEditor.deleteSavedQuery(req.params.id, req.params.queryId));
  }, A);
  r.post('/api/admin/queries/export', async (req, res) => {
    const { rows, format } = req.body || {};
    if (format === 'json') {
      const body = JSON.stringify(rows || [], null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      return res.end(body);
    }
    const csv = ctx.sqlEditor.toCsv(rows || []);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': Buffer.byteLength(csv) });
    res.end(csv);
  }, A);
  r.get('/api/admin/connections/:id/activity', async (req, res) => {
    res.json(200, {
      activity: ctx.system.all('SELECT * FROM db_activity WHERE connection_id = ? ORDER BY id DESC LIMIT 100', [req.params.id]),
    });
  }, A);
  r.post('/api/admin/connections/:id/export-dump', async (req, res) => {
    perm(req, 'db.admin');
    const dump = await ctx.database.exportDump(req.params.id);
    const body = String(dump);
    res.writeHead(200, {
      'Content-Type': 'application/sql',
      'Content-Disposition': `attachment; filename="dump-${req.params.id}.sql"`,
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }, A);
  r.post('/api/admin/connections/:id/import-dump', async (req, res) => {
    perm(req, 'db.admin');
    const { sql } = req.body || {};
    if (!sql) throw badRequest('sql is required');
    res.json(200, await ctx.database.importDump(req.params.id, sql));
  }, A);

  // ── Migrations ──
  r.get('/api/admin/projects/:id/migrations', async (req, res) => {
    const connectionId = req.query.connectionId || ctx.database.getDefaultConnection(req.params.id)?.id;
    if (!connectionId) throw badRequest('Project has no connection');
    res.json(200, { migrations: ctx.migrations.list(req.params.id, connectionId), validation: ctx.migrations.validate(req.params.id, connectionId) });
  }, A);
  r.post('/api/admin/projects/:id/migrations/create', async (req, res) => {
    perm(req, 'migrations.write');
    res.json(200, ctx.migrations.create(req.params.id, req.body?.name || 'migration'));
  }, A);
  r.get('/api/admin/projects/:id/migrations/preview/:filename', async (req, res) => {
    res.json(200, ctx.migrations.preview(req.params.id, req.params.filename));
  }, A);
  r.post('/api/admin/projects/:id/migrations/apply', async (req, res) => {
    perm(req, 'migrations.write');
    const connectionId = req.body?.connectionId || ctx.database.getDefaultConnection(req.params.id)?.id;
    res.json(200, await ctx.migrations.apply(req.params.id, connectionId, { filename: req.body?.filename, dryRun: req.body?.dryRun }));
  }, A);
  r.post('/api/admin/projects/:id/migrations/rollback', async (req, res) => {
    perm(req, 'migrations.write');
    const connectionId = req.body?.connectionId || ctx.database.getDefaultConnection(req.params.id)?.id;
    res.json(200, await ctx.migrations.rollback(req.params.id, connectionId, req.body || {}));
  }, A);

  // ── Branching ──
  r.get('/api/admin/projects/:id/branches', async (req, res) => {
    const connectionId = req.query.connectionId || ctx.database.getDefaultConnection(req.params.id)?.id;
    res.json(200, { branches: connectionId ? ctx.branching.list(req.params.id, connectionId) : [] });
  }, A);
  r.post('/api/admin/projects/:id/branches', async (req, res) => {
    perm(req, 'db.admin');
    const { connectionId, branchName } = req.body || {};
    if (!connectionId || !branchName) throw badRequest('connectionId and branchName are required');
    res.json(200, await ctx.branching.create(req.params.id, connectionId, { branchName }));
  }, A);
  r.post('/api/admin/projects/:id/branches/compare', async (req, res) => {
    perm(req, 'db.read');
    const { connectionIdA, connectionIdB } = req.body || {};
    res.json(200, await ctx.branching.compare(req.params.id, connectionIdA, connectionIdB));
  }, A);
  r.post('/api/admin/projects/:id/branches/sync', async (req, res) => {
    perm(req, 'db.admin');
    const { sourceConnectionId, targetConnectionId, apply } = req.body || {};
    res.json(200, await ctx.branching.sync(req.params.id, sourceConnectionId, targetConnectionId, { apply: apply === true }));
  }, A);
  r.post('/api/admin/projects/:id/branches/promote', async (req, res) => {
    perm(req, 'db.admin');
    const { branchConnectionId, targetConnectionId, apply } = req.body || {};
    if (apply === true && req.body?.confirm !== true) {
      throw badRequest('Promotion with apply=true modifies the target — send confirm: true (or preview first with apply: false)');
    }
    res.json(200, await ctx.branching.promote(req.params.id, branchConnectionId, targetConnectionId, { apply: apply === true }));
  }, A);
  r.delete('/api/admin/projects/:id/branches/:name', async (req, res) => {
    perm(req, 'db.admin');
    res.json(200, await ctx.branching.deleteBranch(req.params.id, req.params.name));
  }, A);

  // ── Row-level security policies ──
  r.get('/api/admin/projects/:id/policies', async (req, res) => {
    res.json(200, { policies: ctx.policies.list(req.params.id) });
  }, A);
  r.post('/api/admin/projects/:id/policies', async (req, res) => {
    perm(req, 'db.admin');
    const check = ctx.policies.validateExpression(req.body?.expression || '');
    if (!check.ok) throw badRequest(`Invalid policy expression: ${check.error}`);
    res.json(200, ctx.policies.add(req.params.id, req.body || {}));
  }, A);
  r.delete('/api/admin/projects/:id/policies/:policyId', async (req, res) => {
    perm(req, 'db.admin');
    res.json(200, ctx.policies.remove(req.params.id, req.params.policyId));
  }, A);
  r.post('/api/admin/policies/validate', async (req, res) => {
    res.json(200, ctx.policies.validateExpression(req.body?.expression || ''));
  }, A);

  // ═══ NoSQL Studio ═══════════════════════════════════════════════════════
  r.get('/api/admin/projects/:id/nosql/mode', async (req, res) => {
    res.json(200, await ctx.nosql.modeFor(req.params.id));
  }, A);
  r.get('/api/admin/projects/:id/nosql/collections', async (req, res) => {
    res.json(200, { collections: await ctx.nosql.listCollections(req.params.id) });
  }, A);
  r.post('/api/admin/projects/:id/nosql/collections', async (req, res) => {
    perm(req, 'db.write');
    res.json(200, await ctx.nosql.createCollection(req.params.id, req.body || {}));
  }, A);
  r.delete('/api/admin/projects/:id/nosql/collections/:name', async (req, res) => {
    perm(req, 'db.admin');
    if (req.body?.confirm !== true) throw badRequest('Collection deletion requires confirm: true');
    res.json(200, await ctx.nosql.dropCollection(req.params.id, req.params.name));
  }, A);
  r.post('/api/admin/projects/:id/nosql/:collection/find', async (req, res) => {
    res.json(200, await ctx.nosql.find(req.params.id, req.params.collection, req.body || {}));
  }, A);
  r.post('/api/admin/projects/:id/nosql/:collection/insert', async (req, res) => {
    perm(req, 'db.write');
    res.json(200, await ctx.nosql.insert(req.params.id, req.params.collection, req.body));
  }, A);
  r.post('/api/admin/projects/:id/nosql/:collection/update', async (req, res) => {
    perm(req, 'db.write');
    const { filter, update, many } = req.body || {};
    res.json(200, await ctx.nosql.update(req.params.id, req.params.collection, filter || {}, update || {}, { many: many === true }));
  }, A);
  r.post('/api/admin/projects/:id/nosql/:collection/delete', async (req, res) => {
    perm(req, 'db.write');
    const { filter, many } = req.body || {};
    res.json(200, await ctx.nosql.delete(req.params.id, req.params.collection, filter || {}, { many: many === true }));
  }, A);
  r.post('/api/admin/projects/:id/nosql/:collection/aggregate', async (req, res) => {
    res.json(200, await ctx.nosql.aggregate(req.params.id, req.params.collection, req.body?.pipeline || []));
  }, A);
  r.get('/api/admin/projects/:id/nosql/:collection/indexes', async (req, res) => {
    res.json(200, { indexes: await ctx.nosql.listIndexes(req.params.id, req.params.collection) });
  }, A);
  r.post('/api/admin/projects/:id/nosql/:collection/indexes', async (req, res) => {
    perm(req, 'db.write');
    res.json(200, await ctx.nosql.createIndex(req.params.id, req.params.collection, req.body || {}));
  }, A);
  r.delete('/api/admin/projects/:id/nosql/:collection/indexes/:indexName', async (req, res) => {
    perm(req, 'db.write');
    res.json(200, await ctx.nosql.dropIndex(req.params.id, req.params.collection, req.params.indexName));
  }, A);
  r.get('/api/admin/projects/:id/nosql/:collection/history/:docId', async (req, res) => {
    res.json(200, await ctx.nosql.documentHistory(req.params.id, req.params.collection, req.params.docId));
  }, A);
  r.post('/api/admin/projects/:id/nosql/:collection/import', async (req, res) => {
    perm(req, 'db.write');
    res.json(200, await ctx.nosql.importJson(req.params.id, req.params.collection, req.body?.documents || []));
  }, A);
  r.get('/api/admin/projects/:id/nosql/:collection/export', async (req, res) => {
    const docs = await ctx.nosql.exportJson(req.params.id, req.params.collection, {});
    const body = JSON.stringify(docs, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${req.params.collection}.json"`,
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }, A);

  // ═══ End-user auth administration ═══════════════════════════════════════
  r.get('/api/admin/projects/:id/auth/users', async (req, res) => {
    res.json(200, ctx.authentication.adminListUsers(req.params.id, {
      limit: Number(req.query.limit || 50), offset: Number(req.query.offset || 0), search: req.query.search || null,
    }));
  }, A);
  r.post('/api/admin/projects/:id/auth/users', async (req, res) => {
    perm(req, 'auth.admin');
    res.json(200, ctx.authentication.adminCreateUser(req.params.id, req.body || {}));
  }, A);
  r.patch('/api/admin/projects/:id/auth/users/:userId', async (req, res) => {
    perm(req, 'auth.admin');
    res.json(200, ctx.authentication.adminUpdateUser(req.params.id, req.params.userId, req.body || {}));
  }, A);
  r.delete('/api/admin/projects/:id/auth/users/:userId', async (req, res) => {
    perm(req, 'auth.admin');
    res.json(200, ctx.authentication.adminDeleteUser(req.params.id, req.params.userId, { purge: req.query.purge === 'true' }));
  }, A);
  r.get('/api/admin/projects/:id/auth/logs', async (req, res) => {
    res.json(200, { logs: ctx.authentication.adminAuthLogs(req.params.id, { limit: Number(req.query.limit || 100), event: req.query.event || null }) });
  }, A);
  r.get('/api/admin/projects/:id/auth/settings', async (req, res) => {
    res.json(200, {
      requireEmailVerification: ctx.security.settingsGet(`auth:${req.params.id}`, 'requireEmailVerification', false),
      smtpConfigured: !!ctx.email.getSettings(req.params.id),
      oauthProviders: ctx.oauth.listConfigs(req.params.id),
    });
  }, A);
  r.put('/api/admin/projects/:id/auth/settings', async (req, res) => {
    perm(req, 'auth.admin');
    const value = req.body?.requireEmailVerification === true;
    ctx.security.settingsSet(`auth:${req.params.id}`, 'requireEmailVerification', value);
    res.json(200, { requireEmailVerification: value });
  }, A);
  r.post('/api/admin/projects/:id/auth/users/:userId/send-verification', async (req, res) => {
    perm(req, 'auth.admin');
    const user = ctx.system.get('SELECT * FROM users WHERE id = ? AND project_id = ?', [req.params.userId, req.params.id]);
    if (!user) throw notFound('User not found');
    const { token } = ctx.authentication._issueToken(req.params.id, user.id, 'email_verify', 24 * 3600);
    const emailed = await ctx.email.sendVerification(req.params.id, user.email, token).catch(() => null);
    res.json(200, emailed?.sent ? { sent: true } : { sent: false, token, note: 'SMTP not configured — token returned for manual delivery' });
  }, A);

  // ═══ OAuth admin ════════════════════════════════════════════════════════
  r.get('/api/admin/projects/:id/oauth', async (req, res) => {
    res.json(200, { configs: ctx.oauth.listConfigs(req.params.id) });
  }, A);
  r.put('/api/admin/projects/:id/oauth', async (req, res) => {
    perm(req, 'auth.admin');
    res.json(200, await ctx.oauth.saveConfig(req.params.id, req.body || {}));
  }, A);
  r.delete('/api/admin/projects/:id/oauth/:provider', async (req, res) => {
    perm(req, 'auth.admin');
    res.json(200, ctx.oauth.deleteConfig(req.params.id, req.params.provider));
  }, A);
  r.post('/api/admin/projects/:id/oauth/:provider/test', async (req, res) => {
    res.json(200, await ctx.oauth.testProvider(req.params.id, req.params.provider));
  }, A);

  // ═══ Email / SMTP admin ═════════════════════════════════════════════════
  r.get('/api/admin/projects/:id/smtp', async (req, res) => {
    res.json(200, { settings: ctx.email.getSettings(req.params.id) });
  }, A);
  r.put('/api/admin/projects/:id/smtp', async (req, res) => {
    perm(req, 'settings.write');
    res.json(200, await ctx.email.saveSettings(req.params.id, req.body || {}));
  }, A);
  r.post('/api/admin/projects/:id/smtp/test', async (req, res) => {
    perm(req, 'settings.write');
    res.json(200, await ctx.email.testSend(req.params.id, req.body?.to));
  }, A);
  r.get('/api/admin/projects/:id/email/templates', async (req, res) => {
    res.json(200, { templates: ctx.email.listTemplates(req.params.id) });
  }, A);
  r.get('/api/admin/projects/:id/email/templates/:name', async (req, res) => {
    res.json(200, ctx.email.getTemplate(req.params.id, req.params.name));
  }, A);
  r.put('/api/admin/projects/:id/email/templates/:name', async (req, res) => {
    perm(req, 'settings.write');
    res.json(200, ctx.email.saveTemplate(req.params.id, req.params.name, req.body || {}));
  }, A);
  r.get('/api/admin/projects/:id/email/log', async (req, res) => {
    res.json(200, { log: ctx.email.deliveryLog(req.params.id, { limit: Number(req.query.limit || 100) }) });
  }, A);

  // ═══ Storage admin ══════════════════════════════════════════════════════
  r.get('/api/admin/projects/:id/buckets', async (req, res) => {
    res.json(200, { buckets: ctx.storage.listBuckets(req.params.id) });
  }, A);
  r.post('/api/admin/projects/:id/buckets', async (req, res) => {
    perm(req, 'storage.admin');
    res.json(200, ctx.storage.createBucket(req.params.id, req.body || {}));
  }, A);
  r.patch('/api/admin/projects/:id/buckets/:bucketId', async (req, res) => {
    perm(req, 'storage.admin');
    res.json(200, ctx.storage.updateBucket(req.params.id, req.params.bucketId, req.body || {}));
  }, A);
  r.delete('/api/admin/projects/:id/buckets/:bucketId', async (req, res) => {
    perm(req, 'storage.admin');
    res.json(200, await ctx.storage.deleteBucket(req.params.id, req.params.bucketId));
  }, A);
  r.get('/api/admin/projects/:id/buckets/:bucketId/objects', async (req, res) => {
    const bucket = ctx.storage.getBucket(req.params.id, req.params.bucketId);
    res.json(200, ctx.storage.listObjects(req.params.id, bucket.name, {
      prefix: req.query.prefix || '', limit: Number(req.query.limit || 100), offset: Number(req.query.offset || 0),
    }));
  }, A);
  r.post('/api/admin/projects/:id/buckets/:bucketId/upload', async (req, res) => {
    perm(req, 'storage.admin');
    const bucket = ctx.storage.getBucket(req.params.id, req.params.bucketId);
    const parsed = req.parseMultipart();
    const file = parsed.files[0];
    if (!file) throw badRequest('multipart upload needs a file field');
    res.json(200, { object: await ctx.storage.upload(req.params.id, bucket.name, {
      filename: file.filename, buffer: file.buffer, mime: file.contentType,
    }) });
  }, A);
  r.get('/api/admin/projects/:id/buckets/:bucketId/download/*', async (req, res) => {
    const bucket = ctx.storage.getBucket(req.params.id, req.params.bucketId);
    const { object, buffer } = await ctx.storage.getObject(req.params.id, bucket.name, req.params.splat);
    let out = buffer, mime = object.mime;
    if (req.query.width || req.query.height || req.query.format) {
      const t = await ctx.storage.transform(buffer, object.mime, req.query);
      out = t.buffer; mime = t.mime;
    }
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': out.length, 'Content-Disposition': `inline; filename="${encodeURIComponent(object.path)}"` });
    res.end(out);
  }, A);
  r.delete('/api/admin/projects/:id/buckets/:bucketId/objects/*', async (req, res) => {
    perm(req, 'storage.admin');
    const bucket = ctx.storage.getBucket(req.params.id, req.params.bucketId);
    res.json(200, await ctx.storage.deleteObject(req.params.id, bucket.name, req.params.splat));
  }, A);
  r.post('/api/admin/projects/:id/buckets/:bucketId/sign', async (req, res) => {
    const bucket = ctx.storage.getBucket(req.params.id, req.params.bucketId);
    res.json(200, ctx.storage.signUrl(req.params.id, bucket.name, req.body?.path, { ttlSeconds: req.body?.ttlSeconds }));
  }, A);
  r.get('/api/admin/projects/:id/storage/usage', async (req, res) => {
    res.json(200, ctx.storage.usageStats(req.params.id));
  }, A);
  r.get('/api/admin/projects/:id/storage/s3', async (req, res) => {
    res.json(200, { config: ctx.s3.getProjectConfig(req.params.id) });
  }, A);
  r.put('/api/admin/projects/:id/storage/s3', async (req, res) => {
    perm(req, 'settings.write');
    ctx.s3.saveProjectConfig(req.params.id, req.body || {});
    res.json(200, { saved: true, config: ctx.s3.getProjectConfig(req.params.id) });
  }, A);
  r.post('/api/admin/storage/s3/test', async (req, res) => {
    res.json(200, await ctx.s3.testConfig(req.body || {}));
  }, A);

  // ═══ Functions admin ════════════════════════════════════════════════════
  r.get('/api/admin/projects/:id/functions', async (req, res) => {
    res.json(200, { functions: ctx.functions.list(req.params.id) });
  }, A);
  r.post('/api/admin/projects/:id/functions', async (req, res) => {
    perm(req, 'functions.write');
    res.json(200, await ctx.functions.create(req.params.id, { ...req.body, code: req.body?.code ?? DEFAULT_FUNCTION_TEMPLATE() }));
  }, A);
  r.get('/api/admin/projects/:id/functions/:fnId', async (req, res) => {
    const fn = ctx.functions.get(req.params.id, req.params.fnId);
    res.json(200, fn);
  }, A);
  r.patch('/api/admin/projects/:id/functions/:fnId', async (req, res) => {
    perm(req, 'functions.write');
    res.json(200, await ctx.functions.update(req.params.id, req.params.fnId, req.body || {}));
  }, A);
  r.delete('/api/admin/projects/:id/functions/:fnId', async (req, res) => {
    perm(req, 'functions.write');
    res.json(200, ctx.functions.delete(req.params.id, req.params.fnId));
  }, A);
  r.post('/api/admin/projects/:id/functions/:fnId/invoke', async (req, res) => {
    perm(req, 'functions.invoke');
    res.json(200, await ctx.functions.invoke(req.params.id, req.params.fnId, { trigger: 'manual', event: req.body?.event || {} }));
  }, A);
  r.get('/api/admin/projects/:id/functions/:fnId/logs', async (req, res) => {
    res.json(200, ctx.functions.logs(req.params.id, req.params.fnId, { limit: Number(req.query.limit || 100) }));
  }, A);
  r.delete('/api/admin/projects/:id/functions/:fnId/logs', async (req, res) => {
    perm(req, 'functions.write');
    res.json(200, ctx.functions.clearLogs(req.params.id, req.params.fnId));
  }, A);
  r.put('/api/admin/projects/:id/functions/:fnId/secrets', async (req, res) => {
    perm(req, 'functions.write');
    res.json(200, ctx.functions.setSecrets(req.params.id, req.params.fnId, req.body?.secrets || []));
  }, A);
  r.get('/api/admin/projects/:id/endpoints', async (req, res) => {
    res.json(200, { endpoints: ctx.functions.listEndpoints(req.params.id) });
  }, A);
  r.post('/api/admin/projects/:id/endpoints', async (req, res) => {
    perm(req, 'functions.write');
    res.json(200, ctx.functions.createEndpoint(req.params.id, req.body || {}));
  }, A);
  r.delete('/api/admin/projects/:id/endpoints/:epId', async (req, res) => {
    perm(req, 'functions.write');
    res.json(200, ctx.functions.deleteEndpoint(req.params.id, req.params.epId));
  }, A);

  // ═══ Webhooks ═══════════════════════════════════════════════════════════
  r.get('/api/admin/projects/:id/webhooks', async (req, res) => {
    res.json(200, { webhooks: ctx.webhooks.list(req.params.id) });
  }, A);
  r.post('/api/admin/projects/:id/webhooks', async (req, res) => {
    perm(req, 'webhooks.admin');
    res.json(200, ctx.webhooks.create(req.params.id, req.body || {}));
  }, A);
  r.patch('/api/admin/projects/:id/webhooks/:whId', async (req, res) => {
    perm(req, 'webhooks.admin');
    res.json(200, ctx.webhooks.update(req.params.id, req.params.whId, req.body || {}));
  }, A);
  r.delete('/api/admin/projects/:id/webhooks/:whId', async (req, res) => {
    perm(req, 'webhooks.admin');
    res.json(200, ctx.webhooks.delete(req.params.id, req.params.whId));
  }, A);
  r.get('/api/admin/projects/:id/webhooks/:whId/deliveries', async (req, res) => {
    res.json(200, { deliveries: ctx.webhooks.deliveries(req.params.id, req.params.whId, { limit: Number(req.query.limit || 100) }) });
  }, A);
  r.post('/api/admin/projects/:id/webhooks/:whId/test', async (req, res) => {
    perm(req, 'webhooks.admin');
    res.json(200, await ctx.webhooks.testPing(req.params.id, req.params.whId));
  }, A);
  r.post('/api/admin/projects/:id/webhooks/:whId/rotate-secret', async (req, res) => {
    perm(req, 'webhooks.admin');
    res.json(200, ctx.webhooks.rotateSecret(req.params.id, req.params.whId));
  }, A);
  r.post('/api/admin/projects/:id/webhooks/deliveries/:deliveryId/retry', async (req, res) => {
    perm(req, 'webhooks.admin');
    res.json(200, await ctx.webhooks.retryDelivery(req.params.id, req.params.deliveryId));
  }, A);

  // ═══ Scheduler & backups ════════════════════════════════════════════════
  r.get('/api/admin/projects/:id/jobs', async (req, res) => {
    res.json(200, { jobs: ctx.scheduler.list(req.params.id) });
  }, A);
  r.post('/api/admin/projects/:id/jobs', async (req, res) => {
    perm(req, 'settings.write');
    res.json(200, ctx.scheduler.create(req.params.id, req.body || {}));
  }, A);
  r.patch('/api/admin/projects/:id/jobs/:jobId', async (req, res) => {
    perm(req, 'settings.write');
    res.json(200, ctx.scheduler.update(req.params.id, req.params.jobId, req.body || {}));
  }, A);
  r.delete('/api/admin/projects/:id/jobs/:jobId', async (req, res) => {
    perm(req, 'settings.write');
    res.json(200, ctx.scheduler.delete(req.params.id, req.params.jobId));
  }, A);
  r.post('/api/admin/projects/:id/jobs/:jobId/run', async (req, res) => {
    perm(req, 'settings.write');
    res.json(200, await ctx.scheduler.runNow(req.params.id, req.params.jobId));
  }, A);
  r.get('/api/admin/projects/:id/jobs/:jobId/runs', async (req, res) => {
    res.json(200, { runs: ctx.scheduler.runs(req.params.id, req.params.jobId) });
  }, A);
  r.get('/api/admin/projects/:id/backups', async (req, res) => {
    res.json(200, { backups: ctx.backups.list(req.params.id), schedules: ctx.backupScheduler.schedules(req.params.id) });
  }, A);
  r.post('/api/admin/projects/:id/backups', async (req, res) => {
    perm(req, 'backups.admin');
    res.json(200, await ctx.backups.createBackup(req.params.id, req.body || {}));
  }, A);
  r.post('/api/admin/projects/:id/backups/schedules', async (req, res) => {
    perm(req, 'backups.admin');
    res.json(200, ctx.backupScheduler.createSchedule(req.params.id, req.body || {}));
  }, A);
  r.delete('/api/admin/projects/:id/backups/schedules/:jobId', async (req, res) => {
    perm(req, 'backups.admin');
    res.json(200, ctx.backupScheduler.deleteSchedule(req.params.id, req.params.jobId));
  }, A);
  r.get('/api/admin/backups/:id', async (req, res) => {
    res.json(200, ctx.backups.get(req.params.id));
  }, A);
  r.post('/api/admin/backups/:id/verify', async (req, res) => {
    perm(req, 'backups.admin');
    res.json(200, await ctx.backups.verify(req.params.id));
  }, A);
  r.post('/api/admin/backups/:id/restore', async (req, res) => {
    perm(req, 'backups.admin');
    res.json(200, await ctx.backups.restore(req.params.id, req.body || {}));
  }, A);
  r.get('/api/admin/backups/:id/download', async (req, res) => {
    perm(req, 'backups.admin');
    const { buffer } = await ctx.backups.downloadFile(req.params.id);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${path.basename(ctx.backups.get(req.params.id).path)}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }, A);
  r.delete('/api/admin/backups/:id', async (req, res) => {
    perm(req, 'backups.admin');
    res.json(200, await ctx.backups.delete(req.params.id));
  }, A);
  r.get('/api/admin/projects/:id/restore-jobs', async (req, res) => {
    res.json(200, { jobs: ctx.backups.restoreJobs(req.params.id) });
  }, A);
  r.get('/api/admin/dr/plan', async (req, res) => {
    res.json(200, ctx.dr.drPlan());
  }, A);
  r.post('/api/admin/dr/restore-test', async (req, res) => {
    perm(req, 'backups.admin');
    res.json(200, await ctx.dr.restoreTest(req.body?.backupId));
  }, A);

  // ═══ Observability: logs, metrics, traces, health, audit, CDC ═══════════
  r.get('/api/admin/logs', async (req, res) => {
    res.json(200, {
      logs: ctx.observability.searchLogs({
        level: req.query.level || null, source: req.query.source || null, contains: req.query.contains || null,
        since: req.query.since || null, projectId: req.query.projectId || null, limit: Number(req.query.limit || 200),
      }),
    });
  }, A);
  r.get('/api/admin/requests', async (req, res) => {
    res.json(200, {
      requests: ctx.observability.searchRequests({
        projectId: req.query.projectId || null, status: req.query.status || null,
        minDurationMs: req.query.minDurationMs ? Number(req.query.minDurationMs) : null,
        limit: Number(req.query.limit || 200),
      }),
    });
  }, A);
  r.get('/api/admin/audit-logs', async (req, res) => {
    const result = ctx.audit.list({
      projectId: req.query.projectId || null, actor: req.query.actor || null, action: req.query.action || null,
      since: req.query.since || null, limit: Number(req.query.limit || 200), offset: Number(req.query.offset || 0),
    });
    if (req.query.format === 'csv') {
      const csv = ctx.audit.exportCsv(result.entries);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': Buffer.byteLength(csv) });
      return res.end(csv);
    }
    res.json(200, result);
  }, A);
  r.get('/api/admin/metrics/summary', async (req, res) => {
    res.json(200, ctx.metrics.snapshot());
  }, A);
  r.get('/api/admin/metrics/prometheus', async (req, res) => {
    res.text(200, ctx.metrics.prometheus(), 'text/plain; version=0.0.4');
  }, A);
  r.get('/api/admin/traces', async (req, res) => {
    res.json(200, { traces: ctx.tracing.recent({ limit: Number(req.query.limit || 100), path: req.query.path || null, minDurationMs: Number(req.query.minDurationMs || 0) || null, status: req.query.status || null }) });
  }, A);
  r.get('/api/admin/traces/:traceId', async (req, res) => {
    const trace = ctx.tracing.get(req.params.traceId);
    if (!trace) throw notFound('Trace not found');
    res.json(200, trace);
  }, A);
  r.get('/api/admin/health/detailed', async (req, res) => {
    res.json(200, await ctx.health.run());
  }, A);
  r.get('/api/admin/observability/overview', async (req, res) => {
    res.json(200, await ctx.observability.dashboardSummary());
  }, A);
  r.get('/api/admin/cdc/status', async (req, res) => {
    res.json(200, ctx.cdc.status());
  }, A);
  r.get('/api/admin/projects/:id/cdc/events', async (req, res) => {
    res.json(200, { events: ctx.cdc.recentEvents(req.params.id, { limit: Number(req.query.limit || 100) }) });
  }, A);
  r.post('/api/admin/projects/:id/cdc/replay', async (req, res) => {
    perm(req, 'db.admin');
    res.json(200, await ctx.cdc.replay(req.params.id, { since: req.body?.since || null }));
  }, A);
  r.post('/api/admin/connections/:id/cdc/install-triggers', async (req, res) => {
    perm(req, 'db.admin');
    res.json(200, await ctx.cdc.installPostgresTriggers(req.params.id, req.body?.tables || null));
  }, A);
  r.post('/api/admin/connections/:id/cdc/listen', async (req, res) => {
    perm(req, 'db.admin');
    res.json(200, await ctx.cdc.startPostgresListener(req.params.id));
  }, A);
  r.post('/api/admin/connections/:id/cdc/mongo-watch', async (req, res) => {
    perm(req, 'db.admin');
    res.json(200, await ctx.cdc.startMongoWatcher(req.params.id));
  }, A);

  // ═══ Plugins & marketplace ══════════════════════════════════════════════
  r.get('/api/admin/plugins', async (req, res) => {
    res.json(200, { plugins: ctx.pluginLoader.status(), discovered: ctx.pluginLoader.discover().map((d) => ({ folder: d.folder, name: d.manifest.name, version: d.manifest.version, description: d.manifest.description, permissions: d.manifest.permissions })) });
  }, A);
  r.post('/api/admin/plugins/:name/enable', async (req, res) => {
    perm(req, 'plugins.admin');
    res.json(200, await ctx.pluginLoader.enable(req.params.name));
  }, A);
  r.post('/api/admin/plugins/:name/disable', async (req, res) => {
    perm(req, 'plugins.admin');
    res.json(200, ctx.pluginLoader.disable(req.params.name));
  }, A);
  r.get('/api/admin/marketplace', async (req, res) => {
    res.json(200, await ctx.marketplace.list());
  }, A);
  r.post('/api/admin/marketplace/install', async (req, res) => {
    perm(req, 'plugins.admin');
    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('multipart/form-data')) {
      const parsed = req.parseMultipart();
      const file = parsed.files[0];
      if (!file) throw badRequest('Upload a plugin .zip file');
      res.json(200, await ctx.marketplace.installFromZip(file.buffer, { enable: parsed.fields.enable !== 'false' }));
    } else {
      res.json(200, await ctx.marketplace.installFromPath(req.body?.path, { enable: req.body?.enable !== false }));
    }
  }, A);
  r.post('/api/admin/plugins/:name/uninstall', async (req, res) => {
    perm(req, 'plugins.admin');
    res.json(200, await ctx.marketplace.uninstall(req.params.name));
  }, A);
  r.get('/api/admin/plugins/:name/config', async (req, res) => {
    res.json(200, { config: ctx.marketplace.getPluginConfig(req.params.name) });
  }, A);
  r.put('/api/admin/plugins/:name/config', async (req, res) => {
    perm(req, 'plugins.admin');
    res.json(200, await ctx.marketplace.setPluginConfig(req.params.name, req.body || {}));
  }, A);

  // ═══ SDK generator ══════════════════════════════════════════════════════
  r.post('/api/admin/projects/:id/sdk/preview', async (req, res) => {
    const result = await ctx.sdkGenerator.generate(req.params.id, req.body || {});
    res.json(200, { files: result.files.map((f) => ({ path: f.path, size: f.content.length })), baseUrl: result.baseUrl });
  }, A);
  r.post('/api/admin/projects/:id/sdk/generate', async (req, res) => {
    perm(req, 'sdk.generate');
    const result = await ctx.sdkGenerator.generate(req.params.id, req.body || {});
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="bloop-sdk-${req.params.id}.zip"`,
      'Content-Length': result.zip.length,
    });
    res.end(result.zip);
  }, A);

  // ═══ Migration importers ════════════════════════════════════════════════
  r.get('/api/admin/import/sources', async (req, res) => {
    res.json(200, { sources: ctx.importer.catalog() });
  }, A);
  r.get('/api/admin/projects/:id/import/jobs', async (req, res) => {
    res.json(200, { jobs: ctx.importer.jobs(req.params.id) });
  }, A);
  r.post('/api/admin/projects/:id/import/jobs', async (req, res) => {
    perm(req, 'import.run');
    const { source, config } = req.body || {};
    const job = ctx.importer.createJob(req.params.id, source, config || {});
    const test = await ctx.importer._testConnection(source, config || {});
    if (!test.ok) {
      ctx.system.run("UPDATE import_jobs SET status = 'connection-failed' WHERE id = ?", [job.id]);
      res.json(200, { ...job, connectionTest: test });
    } else {
      res.json(200, { ...job, connectionTest: test });
    }
  }, A);
  r.post('/api/admin/import/jobs/:jobId/introspect', async (req, res) => {
    perm(req, 'import.run');
    const job = ctx.importer.job(req.params.projectId || req.query.projectId, req.params.jobId);
    const introspection = await ctx.importer.introspect(job.project_id, req.params.jobId);
    res.json(200, { introspection, mapping: ctx.importer.previewMapping(job.project_id, req.params.jobId, introspection) });
  }, A);
  r.post('/api/admin/import/jobs/:jobId/run', async (req, res) => {
    perm(req, 'import.run');
    const job = ctx.importer.job(req.query.projectId, req.params.jobId);
    // run asynchronously; poll via status endpoint
    ctx.importer.run(job.project_id, req.params.jobId).catch(() => { });
    res.json(200, { started: true, jobId: req.params.jobId });
  }, A);
  r.get('/api/admin/import/jobs/:jobId/status', async (req, res) => {
    const job = ctx.importer.job(req.query.projectId, req.params.jobId);
    res.json(200, job);
  }, A);

  // ═══ Settings (platform) ════════════════════════════════════════════════
  r.get('/api/admin/settings', async (req, res) => {
    const rows = ctx.system.all('SELECT scope, key, value_json, updated_at FROM settings ORDER BY scope, key');
    const masked = rows.map((row) => {
      let value = row.value_json;
      try { value = JSON.parse(row.value_json); } catch { }
      if (/secret|password|token|key/i.test(row.key) && typeof value === 'string' && value.length > 8) value = '••••••••';
      return { scope: row.scope, key: row.key, value, updated_at: row.updated_at };
    });
    res.json(200, { settings: masked });
  }, A);
  r.patch('/api/admin/settings', async (req, res) => {
    perm(req, 'settings.write');
    const { scope, key, value } = req.body || {};
    const allowed = ['platform', 'security', 'realtime', 'backups', 'logging', 'functions', 'storage', 'observability'];
    if (!allowed.includes(scope)) throw badRequest(`Scope "${scope}" is not editable via settings (allowed: ${allowed.join(', ')})`);
    if (typeof key !== 'string' || key.length > 80) throw badRequest('Invalid settings key');
    ctx.security.settingsSet(scope, key, value);
    ctx.audit?.record({ actor: req.admin.email, action: 'settings.update', target: `${scope}.${key}` });
    res.json(200, { scope, key, value: /secret|password|token|key/i.test(key) ? '••••••••' : value });
  }, A);
  r.get('/api/admin/config', async (req, res) => {
    res.json(200, { config: ctx.config.toJSON() });
  }, A);
  r.patch('/api/admin/config', async (req, res) => {
    perm(req, 'security.admin');
    ctx.config.update(req.body || {});
    const v = ctx.config.validate();
    res.json(200, { updated: true, valid: v.ok, errors: v.errors, note: 'Server host/port changes require a restart to take effect.' });
  }, A);

  // ═══ Docker ═════════════════════════════════════════════════════════════
  r.get('/api/admin/docker/status', async (req, res) => {
    res.json(200, await ctx.docker.status());
  }, A);
  r.post('/api/admin/docker/compose', async (req, res) => {
    perm(req, 'settings.write');
    res.json(200, await ctx.docker.generateCompose(req.body?.services || []));
  }, A);

  // ═══ CLI service is mounted by cli-service.js itself ════════════════════
}

function DEFAULT_FUNCTION_TEMPLATE() {
  return `// Bloop function — runs in an isolated worker with a sandboxed vm context.
// Define an async handler(req, ctx). ctx.secrets / ctx.env are injected.
async function handler(req, ctx) {
  return {
    message: 'Hello from Bloop Functions!',
    received: req.body ?? null,
    query: req.query ?? null,
    time: new Date().toISOString(),
  };
}`;
}

function qIdent(provider, ident) {
  return (provider === 'mysql' || provider === 'mariadb') ? '`' + ident + '`' : '"' + ident + '"';
}

async function createAdminSession(ctx, req, admin) {
  const sessionId = crypto.randomUUID();
  const refreshToken = ctx.security.randomToken(32);
  const now = new Date().toISOString();
  ctx.system.run(
    'INSERT INTO admin_sessions (id, user_id, refresh_hash, user_agent, ip, created_at, expires_at) VALUES (?,?,?,?,?,?,?)',
    [sessionId, admin.id, ctx.security.sha256(refreshToken), (req.headers['user-agent'] || '').slice(0, 160), req.ip, now,
      new Date(Date.now() + ADMIN_REFRESH_TTL_SEC * 1000).toISOString()]
  );
  return {
    accessToken: ctx.security.signAdminJwt({ sub: admin.id, email: admin.email, role: admin.role, sid: sessionId }, ADMIN_SESSION_TTL_SEC),
    refreshToken,
    expiresIn: ADMIN_SESSION_TTL_SEC,
    admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
  };
}

function project_export_name(bundle) {
  return (bundle.project?.slug || 'project') + '-export';
}

export async function register(ctx) {
  // routes are mounted here so every dependency above is registered first
  mountRoutes(ctx);
}
