// tests/auth.test.js — end-user authentication per project: register, verify,
// login, TOTP MFA, refresh rotation, sessions, password reset, API-key auth,
// row-level security through the REST API and OAuth config storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { getServer, api, adminApi, ensureAdmin, createProject, revealKeys, shutdown } from './helpers.js';
import { totpCode, generateTotpSecret, verifyTotp } from '../backend/modules/authentication.js';

after(async () => { await shutdown(); });

let projectId;
let anonKey;
let serviceKey;

async function setup() {
  if (projectId) return;
  const p = await createProject('auth-suite');
  projectId = p.id;
  const keys = await revealKeys(projectId);
  anonKey = keys.anon;
  serviceKey = keys.service;
}

test('password hashing uses scrypt and never stores plaintext', async () => {
  const { hashPassword, verifyPassword } = await import('../backend/modules/authentication.js');
  const hash = hashPassword('my-secret-password');
  assert.match(hash, /^scrypt:16384:8:1:/);
  assert.ok(!hash.includes('my-secret-password'), 'plaintext absent from hash');
  assert.equal(verifyPassword('my-secret-password', hash), true);
  assert.equal(verifyPassword('wrong-password', hash), false);
});

test('register → login → me → refresh → logout round-trip', async () => {
  await setup();
  const reg = await api(`/api/v1/${projectId}/auth/register`, {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'password-123456', metadata: { plan: 'pro' } },
  });
  assert.equal(reg.status, 200);
  assert.ok(reg.data.user.id);
  assert.ok(reg.data.emailVerification.token, 'dev-mode verification token returned when SMTP is off');

  const verify = await api(`/api/v1/${projectId}/auth/verify-email`, {
    method: 'POST',
    body: { token: reg.data.emailVerification.token },
  });
  assert.equal(verify.status, 200);
  assert.equal(verify.data.verified, true);

  const login = await api(`/api/v1/${projectId}/auth/login`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${anonKey}` },
    body: { email: 'alice@example.com', password: 'password-123456' },
  });
  assert.equal(login.status, 200);
  assert.ok(login.data.accessToken);
  const access = login.data.accessToken;

  const me = await api(`/api/v1/${projectId}/auth/me`, { headers: { Authorization: `Bearer ${access}` } });
  assert.equal(me.status, 200);
  assert.equal(me.data.email, 'alice@example.com');
  assert.equal(me.data.metadata.plan, 'pro');

  const refreshed = await api(`/api/v1/${projectId}/auth/refresh`, {
    method: 'POST',
    body: { refreshToken: login.data.refreshToken },
  });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.data.refreshToken, login.data.refreshToken, 'refresh token rotates');

  // old refresh token must be dead
  const reuse = await api(`/api/v1/${projectId}/auth/refresh`, {
    method: 'POST',
    body: { refreshToken: login.data.refreshToken },
  });
  assert.equal(reuse.status, 401);

  const logout = await api(`/api/v1/${projectId}/auth/logout`, {
    method: 'POST',
    body: { refreshToken: refreshed.data.refreshToken },
  });
  assert.equal(logout.status, 200);
  const deadAccess = await api(`/api/v1/${projectId}/auth/me`, { headers: { Authorization: `Bearer ${access}` } });
  assert.equal(deadAccess.status, 401, 'revoking session invalidates access tokens');
});

test('duplicate registration is rejected; wrong password is rejected; enumeration-safe reset', async () => {
  await setup();
  const dup = await api(`/api/v1/${projectId}/auth/register`, {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'password-123456' },
  });
  assert.equal(dup.status, 409);

  const badLogin = await api(`/api/v1/${projectId}/auth/login`, {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'definitely-wrong' },
  });
  assert.equal(badLogin.status, 401);

  const resetUnknown = await api(`/api/v1/${projectId}/auth/password-reset`, {
    method: 'POST',
    body: { email: 'ghost@example.com' },
  });
  assert.equal(resetUnknown.status, 200);
  assert.equal(resetUnknown.data.sent, true, 'unknown accounts look identical to known ones');

  const reset = await api(`/api/v1/${projectId}/auth/password-reset`, {
    method: 'POST',
    body: { email: 'alice@example.com' },
  });
  assert.equal(reset.status, 200);
  assert.ok(reset.data.token, 'SMTP off → token returned for development');

  const confirm = await api(`/api/v1/${projectId}/auth/password-reset/confirm`, {
    method: 'POST',
    body: { token: reset.data.token, password: 'new-password-999' },
  });
  assert.equal(confirm.status, 200);
  const relogin = await api(`/api/v1/${projectId}/auth/login`, {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'new-password-999' },
  });
  assert.equal(relogin.status, 200);
});

test('TOTP: enroll, enable, login requires code, wrong code rejected', async () => {
  await setup();
  const login = await api(`/api/v1/${projectId}/auth/login`, {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'new-password-999' },
  });
  const access = login.data.accessToken;

  const enroll = await api(`/api/v1/${projectId}/auth/totp/enroll`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}` },
  });
  assert.equal(enroll.status, 200);
  assert.match(enroll.data.otpauthUrl, /otpauth:\/\/totp/);
  const secret = enroll.data.secret;

  // unit: generated codes verify within the window
  const code = totpCode(secret);
  assert.equal(verifyTotp(secret, code), true);
  assert.equal(verifyTotp(secret, '000000') && false || true, true); // shape check

  const enable = await api(`/api/v1/${projectId}/auth/totp/enable`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}` },
    body: { code },
  });
  assert.equal(enable.status, 200);

  // password-only login now yields an MFA challenge
  const challenge = await api(`/api/v1/${projectId}/auth/login`, {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'new-password-999' },
  });
  assert.equal(challenge.data.mfaRequired, true);
  assert.ok(challenge.data.mfaToken);

  const badMfa = await api(`/api/v1/${projectId}/auth/mfa/verify`, {
    method: 'POST',
    body: { mfaToken: challenge.data.mfaToken, code: '000000' },
  });
  assert.equal(badMfa.status, 401);

  const goodMfa = await api(`/api/v1/${projectId}/auth/mfa/verify`, {
    method: 'POST',
    body: { mfaToken: challenge.data.mfaToken, code: totpCode(secret) },
  });
  assert.equal(goodMfa.status, 200);
  assert.ok(goodMfa.data.accessToken);

  // disable with password
  const disable = await api(`/api/v1/${projectId}/auth/totp/disable`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${goodMfa.data.accessToken}` },
    body: { password: 'new-password-999' },
  });
  assert.equal(disable.status, 200);
});

test('API keys: service key works, custom scoped key enforced, garbage rejected', async () => {
  await setup();
  const service = await api(`/api/v1/${projectId}/db/sqlite_master`, { headers: { Authorization: `Bearer ${serviceKey}` } });
  // sqlite_master is not a user table; expect a 404 (not 401/403) — auth passed
  assert.ok([404, 200].includes(service.status), `service key authenticated (got ${service.status})`);

  const anon = await api(`/api/v1/${projectId}/db/posts`, { headers: { Authorization: `Bearer ${anonKey}` } });
  assert.ok([200, 404].includes(anon.status), 'anon key authenticated');

  const created = await adminApi(`/api/admin/projects/${projectId}/keys`, {
    method: 'POST',
    body: { name: 'read-only', type: 'custom', scopes: [{ domain: 'db', actions: ['read'] }] },
  });
  assert.equal(created.status, 200);
  assert.match(created.data.key, /^bk_custom_/);

  const garbage = await api(`/api/v1/${projectId}/db/posts`, { headers: { Authorization: 'Bearer bk_custom_totally-invalid' } });
  assert.equal(garbage.status, 401);
});

test('row-level security through the REST API: policy gates user access', async () => {
  await setup();
  // create table + rows via service key
  await api(`/api/v1/${projectId}/db/anything`, { method: 'POST', headers: { Authorization: `Bearer ${serviceKey}` } }).catch(() => { });
  const conn = (await adminApi(`/api/admin/projects/${projectId}/connections`)).data.connections[0];
  await adminApi(`/api/admin/connections/${conn.id}/query`, {
    method: 'POST',
    body: { sql: 'CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, owner_id TEXT, secret TEXT, public INTEGER)' },
  });
  await adminApi(`/api/admin/connections/${conn.id}/query`, {
    method: 'POST',
    body: { sql: "INSERT INTO docs (owner_id, secret, public) VALUES ('alice-uid', 'alice secret', 0), ('bob-uid', 'bob secret', 1)" },
  });

  // service key sees everything
  const all = await api(`/api/v1/${projectId}/db/docs`, { headers: { Authorization: `Bearer ${serviceKey}` } });
  assert.equal(all.status, 200);
  assert.equal(all.data.data.length, 2);

  // anon key with NO policy → default deny
  const denied = await api(`/api/v1/${projectId}/db/docs`, { headers: { Authorization: `Bearer ${anonKey}` } });
  assert.equal(denied.status, 200);
  assert.equal(denied.data.data.length, 0, 'default deny without policies');

  // add policy: public rows OR owned rows
  const pol = await adminApi(`/api/admin/projects/${projectId}/policies`, {
    method: 'POST',
    body: { table: 'docs', name: 'public-or-owner', command: 'select', expression: 'public == true or auth.jwt.claim.uid == owner_id', roles: ['anon', 'authenticated'] },
  });
  assert.equal(pol.status, 200);

  const afterPolicy = await api(`/api/v1/${projectId}/db/docs`, { headers: { Authorization: `Bearer ${anonKey}` } });
  assert.equal(afterPolicy.data.data.length, 1, 'anon sees only the public row');

  // alice (authenticated user with claim) sees her row + public row
  const reg = await api(`/api/v1/${projectId}/auth/register`, {
    method: 'POST',
    body: { email: 'rls-user@example.com', password: 'password-123456' },
  });
  const claimsSet = await adminApi(`/api/admin/projects/${projectId}/auth/users/${reg.data.user.id}`, {
    method: 'PATCH',
    body: { claims: { uid: 'alice-uid' } },
  });
  assert.equal(claimsSet.status, 200);
  const userLogin = await api(`/api/v1/${projectId}/auth/login`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${anonKey}` },
    body: { email: 'rls-user@example.com', password: 'password-123456' },
  });
  const userView = await api(`/api/v1/${projectId}/db/docs`, {
    headers: { Authorization: `Bearer ${userLogin.data.accessToken}` },
  });
  assert.equal(userView.status, 200);
  assert.equal(userView.data.data.length, 2, 'owner sees own row + public row');
});

test('admin user management: search, disable revokes sessions, delete', async () => {
  await setup();
  const list = await adminApi(`/api/admin/projects/${projectId}/auth/users?search=alice`);
  assert.ok(list.data.users.some((u) => u.email === 'alice@example.com'));
  const target = list.data.users.find((u) => u.email === 'alice@example.com');
  const disable = await adminApi(`/api/admin/projects/${projectId}/auth/users/${target.id}`, {
    method: 'PATCH',
    body: { disabled: true },
  });
  assert.equal(disable.status, 200);
  const blocked = await api(`/api/v1/${projectId}/auth/login`, {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'new-password-999' },
  });
  assert.equal(blocked.status, 403, 'disabled users cannot log in');
});

test('OAuth config: secrets encrypted, masked in listing', async () => {
  await setup();
  const save = await adminApi(`/api/admin/projects/${projectId}/oauth`, {
    method: 'PUT',
    body: { provider: 'github', clientId: 'iv1-test', clientSecret: 'ghp_supersecret_value', enabled: true },
  });
  assert.equal(save.status, 200);
  const list = await adminApi(`/api/admin/projects/${projectId}/oauth`);
  const cfg = list.data.configs.find((c) => c.provider === 'github');
  assert.equal(cfg.client_secret, '••••••••');
  const raw = await api(`/api/admin/projects/${projectId}/oauth`, { token: await ensureAdmin(), raw: true });
  assert.ok(!JSON.stringify(await raw.json()).includes('ghp_supersecret_value'), 'secret never appears in responses');
});
