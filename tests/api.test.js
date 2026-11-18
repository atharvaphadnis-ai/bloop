// tests/api.test.js — auto REST API (filters, ordering, pagination, count,
// embed), GraphQL (query/mutation/introspection), storage (upload/list/
// download/signed URLs), functions (invoke + timeout), webhooks (real HTTP
// delivery + signature), backups (verified artifacts + restore), SDK ZIP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import http from 'node:http';
import crypto from 'node:crypto';
import { getServer, api, adminApi, ensureAdmin, createProject, revealKeys, shutdown } from './helpers.js';
import { createZip, readZip } from '../backend/infrastructure/sdk-generator.js';

after(async () => { await shutdown(); });

let projectId;
let serviceKey;
let anonKey;
const connId = async () => {
  const conns = await adminApi(`/api/admin/projects/${projectId}/connections`);
  return conns.data.connections[0].id;
};

async function setup() {
  if (projectId) return;
  const p = await createProject('api-suite');
  projectId = p.id;
  const keys = await revealKeys(projectId);
  anonKey = keys.anon;
  serviceKey = keys.service;
  const c = await connId();
  await adminApi(`/api/admin/connections/${c}/query`, {
    method: 'POST',
    body: { sql: 'CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, status TEXT, views INTEGER DEFAULT 0, author_id TEXT, created_at TEXT)' },
  });
  await adminApi(`/api/admin/connections/${c}/query`, {
    method: 'POST',
    body: {
      sql: "INSERT INTO posts (title, status, views, author_id, created_at) VALUES ('first', 'published', 10, 'u1', '2026-01-01'), ('second', 'draft', 3, 'u1', '2026-01-02'), ('third', 'published', 30, 'u2', '2026-01-03')",
    },
  });
}

test('REST: list, filter with operators, order, pagination, count', async () => {
  await setup();
  const all = await api(`/api/v1/${projectId}/db/posts?order=id.asc`, { headers: { Authorization: `Bearer ${serviceKey}` } });
  assert.equal(all.status, 200);
  assert.equal(all.data.data.length, 3);

  const filtered = await api(`/api/v1/${projectId}/db/posts?status=eq.published&order=views.desc`, { headers: { Authorization: `Bearer ${serviceKey}` } });
  assert.equal(filtered.data.data.length, 2);
  assert.equal(filtered.data.data[0].title, 'third');

  const gte = await api(`/api/v1/${projectId}/db/posts?views=gte.10&count=exact`, { headers: { Authorization: `Bearer ${serviceKey}` } });
  assert.equal(gte.data.count, 2);

  const paged = await api(`/api/v1/${projectId}/db/posts?limit=2&offset=1&order=id.asc`, { headers: { Authorization: `Bearer ${serviceKey}` } });
  assert.equal(paged.data.data.length, 2);
  assert.equal(paged.data.data[0].id, 2);

  const inFilter = await api(`/api/v1/${projectId}/db/posts?status=in.published,draft`, { headers: { Authorization: `Bearer ${serviceKey}` } });
  assert.equal(inFilter.data.data.length, 3);
});

test('REST: insert (single + bulk), upsert, update by pk, delete by pk', async () => {
  await setup();
  const ins = await api(`/api/v1/${projectId}/db/posts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}` },
    body: { title: 'new post', status: 'draft', views: 1 },
  });
  assert.equal(ins.status, 200);
  assert.ok(ins.data.data.id);

  const bulk = await api(`/api/v1/${projectId}/db/posts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}` },
    body: [{ title: 'b1', status: 'draft' }, { title: 'b2', status: 'draft' }],
  });
  assert.equal(bulk.data.inserted, 2);

  const upsert = await api(`/api/v1/${projectId}/db/posts`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${serviceKey}` },
    body: { id: ins.data.data.id, title: 'upserted', status: 'published' },
  });
  assert.equal(upsert.data.action, 'update');

  const upd = await api(`/api/v1/${projectId}/db/posts/${ins.data.data.id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${serviceKey}` },
    body: { views: 99 },
  });
  assert.equal(upd.status, 200);

  const del = await api(`/api/v1/${projectId}/db/posts/${ins.data.data.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${serviceKey}` },
  });
  assert.equal(del.data.deleted, 1);

  // mass update without filter is blocked
  const mass = await api(`/api/v1/${projectId}/db/posts?title=eq.b1`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${serviceKey}` },
    body: { views: 1 },
  });
  assert.equal(mass.status, 200); // filter present → allowed
  const noFilter = await api(`/api/v1/${projectId}/db/posts`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${serviceKey}` },
    body: { views: 1 },
  });
  assert.equal(noFilter.status, 400, 'unfiltered mass update blocked');
});

test('REST: validation rejects unknown columns and bad types', async () => {
  await setup();
  const bad = await api(`/api/v1/${projectId}/db/posts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}` },
    body: { title: 'ok', not_a_column: true },
  });
  assert.equal(bad.status, 400);
  const badType = await api(`/api/v1/${projectId}/db/posts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}` },
    body: { title: 'ok', views: 'not-a-number' },
  });
  assert.equal(badType.status, 400);
});

test('REST: OpenAPI document is generated with schemas and paths', async () => {
  await setup();
  const spec = await api(`/api/v1/${projectId}/openapi.json`, { headers: { Authorization: `Bearer ${anonKey}` } });
  assert.equal(spec.data.openapi, '3.0.3');
  assert.ok(spec.data.paths[`/db/posts`]);
  assert.ok(spec.data.components.schemas.posts);
});

test('GraphQL: list query, filters, byPk, insert/update/delete mutations, introspection', async () => {
  await setup();
  const gql = (query, variables) => api(`/api/v1/${projectId}/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}` },
    body: { query, variables },
  });

  const list = await gql(`query { posts(limit: 2, where: "{\\"status\\": \\"published\\"}", order: "views.desc") { id title views } }`);
  assert.equal(list.status, 200);
  assert.ok(!list.data.errors, JSON.stringify(list.data.errors || ''));
  assert.equal(list.data.data.posts.length, 2);
  assert.equal(list.data.data.posts[0].title, 'third');

  const one = await gql(`query($id: Int) { postsByPk(pk: $id) { title author_id } }`, { id: 1 });
  assert.equal(one.data.data.postsByPk.title, 'first');

  const ins = await gql(`mutation { insertPosts(objects: [{ title: "from graphql", status: "draft" }]) { id title } }`);
  assert.ok(!ins.data.errors, JSON.stringify(ins.data.errors || ''));
  assert.ok(ins.data.data.insertPosts.length >= 1);

  const upd = await gql(`mutation { updatePosts(where: "{\\"title\\": \\"from graphql\\"}", set: { status: "published" }) }`);
  assert.ok(!upd.data.errors);
  assert.ok(upd.data.data.updatePosts >= 1);

  const del = await gql(`mutation { deletePosts(where: "{\\"title\\": \\"from graphql\\"}") }`);
  assert.ok(!del.data.errors);
  assert.ok(del.data.data.deletePosts >= 1);

  const intro = await gql(`{ __schema { queryType { name } mutationType { name } } }`);
  assert.equal(intro.data.data.__schema.queryType.name, 'Query');
  assert.equal(intro.data.data.__schema.mutationType.name, 'Mutation');

  const variables = await gql(`query ($n: Int) { posts(limit: $n) { id } }`, { n: 1 });
  assert.equal(variables.data.data.posts.length, 1);

  const subscriptionError = await gql(`subscription { posts { id } }`);
  assert.equal(subscriptionError.status, 200);
  assert.match(subscriptionError.data.errors[0].message, /Realtime/);
});

test('storage: bucket, upload, list, download, signed URL, MIME validation', async () => {
  await setup();
  const bucket = await adminApi(`/api/admin/projects/${projectId}/buckets`, {
    method: 'POST',
    body: { name: 'uploads', public: true, maxFileSize: 1024 * 1024 },
  });
  assert.equal(bucket.status, 200);
  const bucketId = bucket.data.id;

  // upload via multipart (admin route)
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('hello bloop storage')]), 'hello.txt');
  const upload = await api(`/api/admin/projects/${projectId}/buckets/${bucketId}/upload`, {
    method: 'POST',
    token: await ensureAdmin(),
    formData: fd,
  });
  assert.equal(upload.status, 200);
  assert.equal(upload.data.object.size, 19);

  const list = await adminApi(`/api/admin/projects/${projectId}/buckets/${bucketId}/objects`);
  assert.equal(list.data.objects.length, 1);
  assert.equal(list.data.objects[0].path, 'hello.txt');

  // download via project API (public bucket, anon key)
  const download = await api(`/api/v1/${projectId}/storage/uploads/hello.txt`, {
    headers: { Authorization: `Bearer ${anonKey}` }, raw: true,
  });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'hello bloop storage');

  // signed URL works
  const sign = await adminApi(`/api/admin/projects/${projectId}/buckets/${bucketId}/sign`, {
    method: 'POST',
    body: { path: 'hello.txt' },
  });
  assert.ok(sign.data.path.startsWith('/storage/signed?token='));
  const signed = await api(sign.data.path, { raw: true });
  assert.equal(signed.status, 200);

  // tampered token is rejected
  const tampered = await api('/storage/signed?token=AAAA.BBBB', { raw: true });
  assert.equal(tampered.status, 403);

  // oversize upload rejected
  const bigFd = new FormData();
  bigFd.append('file', new Blob([Buffer.alloc(2 * 1024 * 1024, 1)]), 'big.bin');
  const bigUpload = await api(`/api/admin/projects/${projectId}/buckets/${bucketId}/upload`, {
    method: 'POST', token: await ensureAdmin(), formData: bigFd,
  });
  assert.equal(bigUpload.status, 413);

  // public delivery route
  const pub = await api(`/storage/public/${projectId}/uploads/hello.txt`, { raw: true });
  assert.equal(pub.status, 200);
});

test('functions: create, invoke in isolated worker, timeout kill, secrets injected', async () => {
  await setup();
  const fn = await adminApi(`/api/admin/projects/${projectId}/functions`, {
    method: 'POST',
    body: {
      slug: 'greeter', name: 'Greeter', timeoutMs: 8000,
      code: `async function handler(req, ctx) { return { msg: 'hi ' + (req.query?.name || 'world'), secretSeen: ctx.secrets.TOKEN, sandboxed: typeof process === 'undefined' } }`,
      secrets: [{ key: 'TOKEN', value: 's3cr3t-value' }],
    },
  });
  assert.equal(fn.status, 200);

  const invoke = await adminApi(`/api/admin/projects/${projectId}/functions/${fn.data.id}/invoke`, {
    method: 'POST',
    body: { event: { query: { name: 'bloop' } } },
  });
  assert.equal(invoke.data.status, 'ok');
  assert.equal(invoke.data.body.msg, 'hi bloop');
  assert.equal(invoke.data.body.secretSeen, 's3cr3t-value');
  assert.equal(invoke.data.body.sandboxed, true, 'process is not exposed inside the sandbox');

  // secrets are masked in reads
  const read = await adminApi(`/api/admin/projects/${projectId}/functions/${fn.data.id}`);
  assert.equal(read.data.secrets[0].value, '••••••••');

  const timeoutFn = await adminApi(`/api/admin/projects/${projectId}/functions`, {
    method: 'POST',
    body: { slug: 'sleeper', code: 'async function handler() { await new Promise(r => setTimeout(r, 60000)); }', timeoutMs: 1000 },
  });
  const slow = await adminApi(`/api/admin/projects/${projectId}/functions/${timeoutFn.data.id}/invoke`, { method: 'POST', body: {} });
  assert.equal(slow.data.status, 'timeout');
  assert.match(slow.data.error, /execution limit/);

  // sandbox rejects require/fs
  const sneaky = await adminApi(`/api/admin/projects/${projectId}/functions`, {
    method: 'POST',
    body: { slug: 'sneaky', code: 'async function handler() { return typeof require !== "undefined" }', timeoutMs: 5000 },
  });
  const sneakRes = await adminApi(`/api/admin/projects/${projectId}/functions/${sneaky.data.id}/invoke`, { method: 'POST', body: {} });
  assert.notEqual(sneakRes.data.body, true, 'require is not available inside the sandbox');
});

test('webhooks: delivery to a real local HTTP server with valid HMAC signature', async () => {
  await setup();
  const received = [];
  const secret = 'whsec_test-secret-123';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200); res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const wh = await adminApi(`/api/admin/projects/${projectId}/webhooks`, {
    method: 'POST',
    body: { name: 'test hook', url: `http://localhost:${port}/hook`, events: ['webhook.ping'], maxRetries: 1 },
  });
  assert.equal(wh.status, 200);
  // overwrite the generated secret with our known one for signature verification
  const rotated = await adminApi(`/api/admin/projects/${projectId}/webhooks/${wh.data.id}/rotate-secret`, { method: 'POST' });

  await adminApi(`/api/admin/projects/${projectId}/webhooks/${wh.data.id}/test`, { method: 'POST' });
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(received.length >= 1, 'webhook was delivered');
  const delivery = received[received.length - 1];
  assert.equal(delivery.headers['x-bloop-event'], 'webhook.ping');
  const expectedSig = 'sha256=' + crypto.createHmac('sha256', rotated.secret).update(delivery.body).digest('hex');
  assert.equal(delivery.headers['x-bloop-signature'], expectedSig, 'HMAC signature verifies');

  const deliveries = await adminApi(`/api/admin/projects/${projectId}/webhooks/${wh.data.id}/deliveries`);
  assert.ok(deliveries.data.deliveries.some((d) => d.status === 'delivered'));
  server.close();
});

test('backups: verified artifact with checksum, restore to a new project, restore test', async () => {
  await setup();
  const backup = await adminApi(`/api/admin/projects/${projectId}/backups`, {
    method: 'POST',
    body: { name: 'suite-backup', encrypt: true },
  });
  assert.equal(backup.status, 200);
  assert.equal(backup.data.status, 'verified', 'backup is never reported successful without verification');
  assert.ok(backup.data.checksum);
  assert.ok(backup.data.size > 0);

  const verify = await adminApi(`/api/admin/backups/${backup.data.id}/verify`, { method: 'POST' });
  assert.equal(verify.data.ok, true);

  const restore = await adminApi(`/api/admin/backups/${backup.data.id}/restore`, {
    method: 'POST',
    body: { mode: 'new-project' },
  });
  assert.equal(restore.status, 200);
  assert.equal(restore.data.projectId ? true : false, true);
  const restoredKeys = await adminApi(`/api/admin/projects/${restore.data.projectId}/keys/reveal`);
  const restoredPosts = await api(`/api/v1/${restore.data.projectId}/db/posts`, { headers: { Authorization: `Bearer ${restoredKeys.data.service}` } });
  assert.equal(restoredPosts.status, 200, 'restored project serves its data');
  assert.ok(restoredPosts.data.data.length >= 3, 'rows survived the restore');

  const drTest = await adminApi('/api/admin/dr/restore-test', {
    method: 'POST',
    body: { backupId: backup.data.id },
  });
  assert.equal(drTest.status, 200);
  assert.equal(drTest.data.ok, true);
});

test('SDK generator produces a valid ZIP with all five languages', async () => {
  await setup();
  const zipBuf = createZip([
    { path: 'a.txt', data: 'AAA' },
    { path: 'dir/b.txt', data: 'BBBB' },
  ]);
  const entries = readZip(zipBuf);
  assert.equal(entries.length, 2);
  assert.equal(entries.find((e) => e.path === 'a.txt').data.toString(), 'AAA');
  assert.equal(entries.find((e) => e.path === 'dir/b.txt').data.toString(), 'BBBB');

  const gen = await api(`/api/admin/projects/${projectId}/sdk/generate`, {
    method: 'POST',
    token: await ensureAdmin(),
    raw: true,
    body: {},
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(gen.status, 200);
  assert.equal(gen.headers.get('content-type'), 'application/zip');
  const files = readZip(Buffer.from(await gen.arrayBuffer()));
  for (const expected of ['bloop-js/index.js', 'bloop-ts/index.ts', 'bloop-python/bloop_client.py', 'bloop-go/bloop.go', 'bloop-dart/bloop_client.dart', 'README.md']) {
    assert.ok(files.find((f) => f.path === expected), `SDK contains ${expected}`);
  }
});

test('CDC events flow through the event bus on writes', async () => {
  await setup();
  const { ctx } = await getServer();
  const events = [];
  const off = ctx.bus.on('db.change', (evt) => events.push(evt));
  await api(`/api/v1/${projectId}/db/posts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}` },
    body: { title: 'cdc-test', status: 'draft' },
  });
  await new Promise((r) => setTimeout(r, 300));
  off();
  const evt = events.find((e) => e.table === 'posts' && e.op === 'insert');
  assert.ok(evt, 'normalized change event emitted');
  assert.equal(evt.projectId, projectId);
  assert.ok(evt.eventId);
});
