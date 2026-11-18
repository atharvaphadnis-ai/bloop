// tests/helpers.js — shared boot fixture: one Bloop server per test run on an
// ephemeral port with an isolated data directory.
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.BLOOP_SECRET = process.env.BLOOP_SECRET || 'bloop-test-secret-0123456789abcdef0123456789';
process.env.BLOOP_LOG_LEVEL = process.env.BLOOP_LOG_LEVEL || 'error';
process.env.BLOOP_DATA_DIR = process.env.BLOOP_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'bloop-data-'));
process.env.BLOOP_BACKUP_DIR = path.join(process.env.BLOOP_DATA_DIR, 'backups');
process.env.BLOOP_SQLITE_ENABLED = 'true';
process.env.BLOOP_PORT = '0'; // ephemeral port — parallel-safe

let shared = null;

export async function getServer() {
  if (shared) return shared;
  const { startApp } = await import('../backend/core/app.js');
  const ctx = await startApp();
  const port = ctx.httpServer.address().port;
  shared = { ctx, port, base: `http://localhost:${port}` };
  return shared;
}

export function token() {
  return shared?.adminToken || null;
}

export async function shutdown() {
  if (!shared) return;
  const ctxRef = shared.ctx;
  shared = null;
  try { await ctxRef.lifecycle.shutdown('test-end'); } catch { }
  try { ctxRef.httpServer.close(); } catch { }
  // force exit — pooled keep-alive sockets and background timers must not hold the runner open
  setTimeout(() => process.exit(0), 150).unref?.();
}

export async function api(path, { method = 'GET', token: tok, body, raw = false, headers = {}, formData = null } = {}) {
  const { base } = await getServer();
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(formData ? {} : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      ...headers,
    },
    body: formData ? formData : body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, headers: res.headers, data };
}

export async function adminApi(path, opts = {}) {
  await ensureAdmin();
  return api(path, { ...opts, token: token() });
}

export async function ensureAdmin() {
  const s = await getServer();
  if (s.adminToken) return s.adminToken;
  const boot = await api('/api/admin/bootstrap');
  if (boot.data.setupRequired) {
    const setup = await api('/api/admin/setup', {
      method: 'POST',
      body: { email: 'owner@test.local', password: 'super-secret-pass-123', name: 'Test Owner' },
    });
    if (setup.status !== 200) throw new Error(`setup failed: ${JSON.stringify(setup.data)}`);
    s.adminToken = setup.data.accessToken;
  } else {
    const login = await api('/api/admin/login', {
      method: 'POST',
      body: { email: 'owner@test.local', password: 'super-secret-pass-123' },
    });
    if (login.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(login.data)}`);
    s.adminToken = login.data.accessToken;
  }
  return s.adminToken;
}

export async function createProject(name = 'test-project') {
  await ensureAdmin();
  const res = await adminApi('/api/admin/projects', { method: 'POST', body: { name } });
  if (res.status !== 200) throw new Error(`project create failed: ${JSON.stringify(res.data)}`);
  return res.data;
}

export async function revealKeys(projectId) {
  const res = await adminApi(`/api/admin/projects/${projectId}/keys/reveal`);
  return res.data;
}
