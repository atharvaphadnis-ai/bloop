// modules/realtime.js — native WebSocket server (RFC 6455, implemented from
// scratch on node:net primitives — no dependencies), with database change
// subscriptions, presence, broadcast, private channels, authorization,
// heartbeats, event filtering and reconnection support.
//
// Client protocol (JSON text frames):
//   → {op:"subscribe",  channel, filter?, token?}
//   → {op:"unsubscribe", channel}
//   → {op:"broadcast",  channel, event, payload}
//   → {op:"presence",   channel, state}
//   → {op:"ping"}
//   ← {type:"ok"|"error"|"event"|"presence"|"pong"|"heartbeat", ...}
import crypto from 'node:crypto';
import { badRequest } from '../core/error-handler.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_TEXT = 0x1, OP_BIN = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xA, OP_CONT = 0x0;

export class WebSocketServer {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'realtime' });
    this.clients = new Set();
    this.channels = new Map();   // channel -> Set<client>
    this.presence = new Map();   // channel -> Map<clientId, state>
    this.dbSubscriptions = [];   // {client, channel, projectId, table, filter}
    this.metrics = { connections: 0, messagesIn: 0, messagesOut: 0, eventsDelivered: 0, rejected: 0 };
    this.heartbeatTimer = null;
    this.maxConnPerProject = ctx.config.get('realtime.maxConnectionsPerProject', 200);
    this.maxMsgRate = ctx.config.get('realtime.maxMessageRatePerSecond', 60);
    this._busOff = [];
  }

  // ── RFC 6455 handshake ────────────────────────────────────────────────────
  handleUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (!key || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    if (head?.length) socket.unshift(head);
    this.attachClient(socket, req);
  }

  attachClient(socket, req) {
    const client = {
      id: crypto.randomUUID(),
      socket,
      req,
      ip: (req.socket.remoteAddress || '').replace('::ffff:', ''),
      authenticated: null,   // {projectId, userId, role} when a valid token is presented
      subscribed: new Set(),
      buffer: Buffer.alloc(0),
      fragments: null,
      lastPong: Date.now(),
      messageTimes: [],
      alive: true,
    };
    this.clients.add(client);
    this.metrics.connections++;

    socket.on('data', (chunk) => this._onData(client, chunk));
    socket.on('error', () => this._drop(client));
    socket.on('close', () => this._drop(client));
    socket.setNoDelay(true);
    socket.on('end', () => this._drop(client));

    // token auth during handshake (?token= or Authorization header)
    try {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (token) {
        const projectId = url.searchParams.get('project');
        if (projectId) client.authenticated = this._verifyToken(projectId, token);
      }
    } catch { /* anonymous client */ }

    this.send(client, { type: 'ok', message: 'connected', clientId: client.id, protocol: 'bloop-realtime-v1' });
    this.startHeartbeats();
  }

  _verifyToken(projectId, token) {
    try {
      const verified = this.ctx.authentication.verifyAccessToken(projectId, token);
      if (!verified) return null;
      return { projectId, userId: verified.payload.sub, role: 'authenticated' };
    } catch {
      return null;
    }
  }

  _drop(client) {
    if (!this.clients.has(client)) return;
    this.clients.delete(client);
    client.alive = false;
    try { client.socket.destroy(); } catch { }
    for (const ch of client.subscribed) {
      const set = this.channels.get(ch);
      if (set) {
        set.delete(client);
        if (!set.size) this.channels.delete(ch);
      }
      const pres = this.presence.get(ch);
      if (pres?.has(client.id)) {
        pres.delete(client.id);
        this.broadcastToChannel(ch, { type: 'presence', channel: ch, action: 'leave', clientId: client.id });
      }
    }
    this.dbSubscriptions = this.dbSubscriptions.filter((s) => s.client !== client);
    this.metrics.connections = this.clients.size;
  }

  // ── Frame codec ───────────────────────────────────────────────────────────
  _onData(client, chunk) {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    while (true) {
      const frame = this._decodeFrame(client);
      if (!frame) break;
      this._handleFrame(client, frame);
      if (!client.alive) break;
    }
  }

  _decodeFrame(client) {
    const buf = client.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > 16 * 1024 * 1024n) { this._drop(client); return null; }
      len = Number(big);
      offset = 10;
    }
    if (len > 16 * 1024 * 1024) { this._drop(client); return null; }
    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    let payload = buf.subarray(offset, offset + len);
    if (mask) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    client.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame(client, { fin, opcode, payload }) {
    if (opcode === OP_PING) {
      this._sendRaw(client, OP_PONG, payload);
      return;
    }
    if (opcode === OP_PONG) {
      client.lastPong = Date.now();
      return;
    }
    if (opcode === OP_CLOSE) {
      try { this._sendRaw(client, OP_CLOSE, payload.subarray(0, 2)); } catch { }
      this._drop(client);
      return;
    }
    if (opcode === OP_CONT) {
      if (!client.fragments) { this._drop(client); return; }
      client.fragments.push(payload);
      if (fin) {
        const full = Buffer.concat(client.fragments);
        client.fragments = null;
        this._onMessage(client, full);
      }
      return;
    }
    if (opcode === OP_TEXT || opcode === OP_BIN) {
      if (!fin) {
        client.fragments = [payload];
        return;
      }
      this._onMessage(client, payload);
      return;
    }
    this._drop(client);
  }

  _onMessage(client, payload) {
    if (opcodeIsBinary(payload)) { /* treat as text anyway */ }
    this.metrics.messagesIn++;
    // message rate limiting
    const now = Date.now();
    client.messageTimes = client.messageTimes.filter((t) => now - t < 1000);
    client.messageTimes.push(now);
    if (client.messageTimes.length > this.maxMsgRate) {
      this.metrics.rejected++;
      this.send(client, { type: 'error', message: 'Message rate exceeded — connection closing' });
      this._drop(client);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(payload.toString('utf8'));
    } catch {
      this.send(client, { type: 'error', message: 'Frames must be JSON text' });
      return;
    }
    try {
      this._dispatch(client, msg);
    } catch (err) {
      this.send(client, { type: 'error', message: err.message });
    }
  }

  _dispatch(client, msg) {
    switch (msg.op) {
      case 'ping': this.send(client, { type: 'pong', ts: Date.now() }); return;
      case 'subscribe': return this._subscribe(client, msg);
      case 'unsubscribe': return this._unsubscribe(client, msg.channel);
      case 'broadcast': return this._broadcast(client, msg);
      case 'presence': return this._presence(client, msg);
      default: this.send(client, { type: 'error', message: `Unknown op "${msg.op}"` });
    }
  }

  _subscribe(client, msg) {
    const channel = String(msg.channel || '');
    if (!channel || channel.length > 120) throw badRequest('Invalid channel name');
    // channel grammar: project:<pid>[:db:<table>|broadcast:<name>|presence:<name>]
    const m = /^project:([a-f0-9-]{36})(?::db:([A-Za-z0-9_]+)|:broadcast:([A-Za-z0-9_-]+)|:presence:([A-Za-z0-9_-]+))?$/.exec(channel);
    if (!m) throw badRequest('Channel must match project:<projectId>[:db:<table>|:broadcast:<name>|:presence:<name>]');
    const projectId = m[1];

    // private channels require a valid token for that project
    if (channel.startsWith('private:') || msg.private) {
      const token = msg.token || client.authenticated?.token;
      const auth = client.authenticated || (msg.token ? this._verifyToken(projectId, msg.token) : null);
      if (!auth || auth.projectId !== projectId) {
        this.metrics.rejected++;
        return this.send(client, { type: 'error', message: 'Private channel requires a valid project token', channel });
      }
    }

    if (m[2]) {
      // database channel — validate table exists for the project's default connection
      const connRow = this.ctx.database.getDefaultConnection(projectId);
      if (!connRow) throw badRequest('Project has no database connection');
      const filter = msg.filter && typeof msg.filter === 'object' ? msg.filter : null;
      this.dbSubscriptions.push({ client, channel, projectId, table: m[2], filter, ops: msg.ops || null });
    }

    let set = this.channels.get(channel);
    if (!set) { set = new Set(); this.channels.set(channel, set); }
    if (set.size >= this.maxConnPerProject) {
      return this.send(client, { type: 'error', message: 'Channel is full', channel });
    }
    set.add(client);
    client.subscribed.add(channel);
    const pres = this.presence.get(channel);
    if (pres) {
      // join announcement to existing members + current members to the joiner
      this.broadcastToChannel(channel, { type: 'presence', channel, action: 'join', clientId: client.id, state: pres.get(client.id) || null }, client);
      this.send(client, { type: 'presence', channel, members: [...pres.entries()].map(([id, state]) => ({ clientId: id, state })) });
    }
    this.send(client, { type: 'ok', op: 'subscribe', channel });
  }

  _unsubscribe(client, channel) {
    const set = this.channels.get(channel);
    if (set) {
      set.delete(client);
      if (!set.size) this.channels.delete(channel);
    }
    client.subscribed.delete(channel);
    this.dbSubscriptions = this.dbSubscriptions.filter((s) => !(s.client === client && s.channel === channel));
    const pres = this.presence.get(channel);
    if (pres?.has(client.id)) {
      pres.delete(client.id);
      this.broadcastToChannel(channel, { type: 'presence', channel, action: 'leave', clientId: client.id });
    }
    this.send(client, { type: 'ok', op: 'unsubscribe', channel });
  }

  _broadcast(client, msg) {
    const channel = String(msg.channel || '');
    const set = this.channels.get(channel);
    if (!set?.has(client)) {
      this.metrics.rejected++;
      return this.send(client, { type: 'error', message: 'Subscribe before broadcasting', channel });
    }
    if (channel.includes(':presence:') || channel.startsWith('private:')) {
      const m = /^project:([a-f0-9-]{36})/.exec(channel);
      const auth = client.authenticated;
      if (!auth || auth.projectId !== m?.[1]) {
        return this.send(client, { type: 'error', message: 'Broadcast on private/presence channels requires authentication' });
      }
    }
    this.broadcastToChannel(channel, {
      type: 'event', channel, event: String(msg.event || 'message'),
      payload: msg.payload ?? null, from: client.id, ts: Date.now(),
    }, client);
    this.send(client, { type: 'ok', op: 'broadcast', channel });
  }

  _presence(client, msg) {
    const channel = String(msg.channel || '');
    const set = this.channels.get(channel);
    if (!set?.has(client)) {
      return this.send(client, { type: 'error', message: 'Subscribe to the presence channel first', channel });
    }
    if (!channel.includes(':presence:')) {
      return this.send(client, { type: 'error', message: 'Presence is only available on project:<id>:presence:<name> channels' });
    }
    let pres = this.presence.get(channel);
    if (!pres) { pres = new Map(); this.presence.set(channel, pres); }
    pres.set(client.id, msg.state ?? null);
    this.broadcastToChannel(channel, { type: 'presence', channel, action: 'update', clientId: client.id, state: msg.state ?? null }, client);
    this.send(client, { type: 'ok', op: 'presence', channel });
  }

  // ── Sending ───────────────────────────────────────────────────────────────
  _sendRaw(client, opcode, payload) {
    if (!client.alive || client.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    client.socket.write(Buffer.concat([header, payload]));
    this.metrics.messagesOut++;
  }

  send(client, obj) {
    this._sendRaw(client, OP_TEXT, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  // Server-side data sync: the data layer calls this after every write, so
  // any subscribed client — dashboard, generated SDK, external app — sees the
  // change instantly. Also mirrored to the bare project channel so a single
  // subscription streams every table of the project.
  notifyDataChange(projectId, table, op, rows = null) {
    if (this.ctx.config.get('realtime.enabled', true) === false) return;
    const event = (channel) => ({ type: 'data', channel, op, table, rows: rows ?? null, ts: Date.now() });
    const tableChannel = `project:${projectId}:db:${table}`;
    if (this.channels.has(tableChannel)) this.broadcastToChannel(tableChannel, event(tableChannel));
    const projectChannel = `project:${projectId}`;
    if (this.channels.has(projectChannel)) this.broadcastToChannel(projectChannel, event(projectChannel));
  }

  broadcastToChannel(channel, obj, except = null) {
    const set = this.channels.get(channel);
    if (!set) return 0;
    let n = 0;
    for (const client of set) {
      if (client === except || !client.alive) continue;
      this.send(client, obj);
      n++;
    }
    return n;
  }

  // ── Database change fan-out (wired to the event bus) ──────────────────────
  onDatabaseChange(evt) {
    let delivered = 0;
    for (const sub of this.dbSubscriptions) {
      if (sub.projectId !== evt.projectId) continue;
      if (sub.table !== evt.table) continue;
      if (sub.ops && Array.isArray(sub.ops) && !sub.ops.includes(evt.op)) continue;
      if (sub.filter) {
        const doc = evt.after || evt.before || {};
        let match = true;
        for (const [k, v] of Object.entries(sub.filter)) {
          if (doc[k] !== v && String(doc[k]) !== String(v)) { match = false; break; }
        }
        if (!match) continue;
      }
      this.send(sub.client, {
        type: 'event',
        channel: sub.channel,
        event: evt.op,
        payload: { table: evt.table, op: evt.op, before: evt.before ?? null, after: evt.after ?? null, eventId: evt.eventId, ts: evt.ts },
        ts: Date.now(),
      });
      delivered++;
    }
    this.metrics.eventsDelivered += delivered;
    return delivered;
  }

  startHeartbeats() {
    if (this.heartbeatTimer) return;
    const interval = this.ctx.config.get('realtime.heartbeatIntervalMs', 30000);
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const client of this.clients) {
        if (now - client.lastPong > interval * 2) {
          this.send(client, { type: 'error', message: 'heartbeat timeout' });
          this._drop(client);
        } else {
          this._sendRaw(client, OP_PING, Buffer.alloc(0));
        }
      }
    }, interval);
    this.heartbeatTimer.unref?.();
  }

  bindEventBus() {
    this._busOff.push(this.ctx.bus.on('db.change', (evt) => this.onDatabaseChange(evt)));
    this._busOff.push(this.ctx.bus.on('broadcast', (evt) => {
      if (evt?.channel) this.broadcastToChannel(evt.channel, { type: 'event', channel: evt.channel, event: evt.event || 'server', payload: evt.payload, ts: Date.now() });
    }));
  }

  stats() {
    return {
      connections: this.clients.size,
      channels: this.channels.size,
      dbSubscriptions: this.dbSubscriptions.length,
      ...this.metrics,
    };
  }

  shutdown() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const client of [...this.clients]) {
      try { this._sendRaw(client, OP_CLOSE, Buffer.from([0x03, 0xE8])); client.socket.destroy(); } catch { }
    }
    this.clients.clear();
    this.channels.clear();
    this.dbSubscriptions = [];
  }
}

function opcodeIsBinary() { return false; }

export async function register(ctx) {
  const wss = new WebSocketServer(ctx);
  ctx.realtime = wss;
}

export function mountRoutes(ctx) {
  // channel registry is admin-visible
  ctx.router.get('/api/admin/realtime/stats', async (req, res) => {
    res.json(200, ctx.realtime.stats());
  }, { auth: 'admin' });
}
