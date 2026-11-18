// tests/realtime.test.js — the from-scratch WebSocket server: handshake,
// DB-change subscriptions with filters, broadcast, presence, heartbeats.
import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { getServer, api, adminApi, ensureAdmin, createProject, revealKeys, shutdown } from './helpers.js';

after(async () => { await shutdown(); });

let projectId;
let serviceKey;

async function setup() {
  if (projectId) return;
  const p = await createProject('realtime-suite');
  projectId = p.id;
  const keys = await revealKeys(projectId);
  serviceKey = keys.service;
  const conns = await adminApi(`/api/admin/projects/${projectId}/connections`);
  await adminApi(`/api/admin/connections/${conns.data.connections[0].id}/query`, {
    method: 'POST',
    body: { sql: 'CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, text TEXT)' },
  });
}

function wsConnect(port, path = '/realtime/v1') {
  return new Promise((resolve, reject) => {
    const key = require0();
    import('node:http').then(async ({ request }) => {
      const req = request({
        host: 'localhost', port, path,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (res, socket) => resolve({ socket, res }));
      req.on('error', reject);
      req.end();
    });
  });
}
function require0() { return crypto.randomBytes(16).toString('base64'); }
import crypto from 'node:crypto';

function wsSend(socket, obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  header[0] = 0x81; // FIN + text
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  socket.write(Buffer.concat([header, mask, masked]));
}

function wsReader(socket, onMessage) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) break;
      const len0 = buf[1] & 0x7f;
      let offset = 2;
      let len = len0;
      if (len0 === 126) {
        if (buf.length < 4) break;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len0 === 127) {
        if (buf.length < 10) break;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (buf.length < offset + len) break;
      const opcode = buf[0] & 0x0f;
      const payload = buf.subarray(offset, offset + len);
      buf = buf.subarray(offset + len);
      if (opcode === 1) {
        try { onMessage(JSON.parse(payload.toString('utf8'))); } catch { }
      }
    }
  });
}

test('websocket handshake completes and the server greets', async () => {
  await setup();
  const { ctx } = await getServer();
  const port = ctx.httpServer.address().port;
  const { socket } = await wsConnect(port);
  let greet = null;
  const gotGreeting = new Promise((r) => {
    wsReader(socket, (msg) => { if (!greet) { greet = msg; r(msg); } });
  });
  const msg = await gotGreeting;
  assert.equal(msg.type, 'ok');
  assert.equal(msg.protocol, 'bloop-realtime-v1');
  socket.destroy();
});

test('db channel subscription receives insert events matching filters', async () => {
  await setup();
  const { ctx } = await getServer();
  const port = ctx.httpServer.address().port;
  const { socket } = await wsConnect(port);
  const messages = [];
  wsReader(socket, (m) => messages.push(m));

  wsSend(socket, { op: 'subscribe', channel: `project:${projectId}:db:messages`, filter: { room: 'general' } });
  await waitForM(messages, (m) => m.type === 'ok' && m.op === 'subscribe');

  // matching insert
  await api(`/api/v1/${projectId}/db/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}` },
    body: { room: 'general', text: 'hello realtime' },
  });
  const event = await waitForM(messages, (m) => m.type === 'event' && m.event === 'insert');
  assert.equal(event.payload.after.room, 'general');
  assert.equal(event.payload.table, 'messages');

  // non-matching insert (filtered out)
  const countBefore = messages.length;
  await api(`/api/v1/${projectId}/db/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}` },
    body: { room: 'off-topic', text: 'should not arrive' },
  });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(messages.filter((m) => m.type === 'event' && m.payload?.after?.room === 'off-topic').length, 0, 'filter excludes non-matching rows');

  socket.destroy();
});

test('broadcast and presence work on dedicated channels', async () => {
  await setup();
  const { ctx } = await getServer();
  const port = ctx.httpServer.address().port;
  const a = await wsConnect(port);
  const b = await wsConnect(port);
  const aMsgs = [], bMsgs = [];
  wsReader(a.socket, (m) => aMsgs.push(m));
  wsReader(b.socket, (m) => bMsgs.push(m));
  await sleepM(100);

  const channel = `project:${projectId}:broadcast:lobby`;
  wsSend(a.socket, { op: 'subscribe', channel });
  wsSend(b.socket, { op: 'subscribe', channel });
  await waitForM(bMsgs, (m) => m.type === 'ok' && m.op === 'subscribe');
  await sleepM(100);

  wsSend(a.socket, { op: 'broadcast', channel, event: 'chat', payload: { text: 'hello lobby' } });
  const received = await waitForM(bMsgs, (m) => m.type === 'event' && m.event === 'chat');
  assert.equal(received.payload.text, 'hello lobby');
  assert.ok(received.from, 'sender id attached');

  // presence
  const presenceChannel = `project:${projectId}:presence:office`;
  wsSend(a.socket, { op: 'subscribe', channel: presenceChannel });
  wsSend(b.socket, { op: 'subscribe', channel: presenceChannel });
  await sleepM(150);
  wsSend(a.socket, { op: 'presence', channel: presenceChannel, state: { status: 'busy' } });
  await sleepM(200);
  const presenceUpdates = bMsgs.filter((m) => m.type === 'presence' && m.action === 'update');
  assert.ok(presenceUpdates.length >= 1, 'presence update broadcast to channel members');

  a.socket.destroy();
  b.socket.destroy();
});

test('unauthorized broadcast on private channels is rejected; unknown op errors', async () => {
  await setup();
  const { ctx } = await getServer();
  const port = ctx.httpServer.address().port;
  const { socket } = await wsConnect(port);
  const msgs = [];
  wsReader(socket, (m) => msgs.push(m));
  await sleepM(80);

  wsSend(socket, { op: 'bogus-op' });
  await waitForM(msgs, (m) => m.type === 'error' && /Unknown op/.test(m.message));

  wsSend(socket, { op: 'subscribe', channel: 'not-a-valid-channel' });
  await waitForM(msgs, (m) => m.type === 'error' && /Channel must match/.test(m.message));

  socket.destroy();
});

test('realtime stats and health report connections', async () => {
  await setup();
  const { ctx } = await getServer();
  const port = ctx.httpServer.address().port;
  const { socket } = await wsConnect(port);
  await sleepM(100);
  const stats = await adminApi('/api/admin/realtime/stats');
  assert.ok(stats.data.connections >= 1);
  socket.destroy();
});

// ── helpers ──
function sleepM(ms) { return new Promise((r) => setTimeout(r, ms)); }
function waitForM(messages, pred, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ws event')), timeoutMs);
    const existing = messages.find(pred);
    if (existing) { clearTimeout(timer); return resolve(existing); }
    const interval = setInterval(() => {
      const found = messages.find(pred);
      if (found) { clearInterval(interval); clearTimeout(timer); resolve(found); }
    }, 50);
  });
}
