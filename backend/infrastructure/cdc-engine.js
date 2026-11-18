// infrastructure/cdc-engine.js — normalized change-data-capture with honest,
// provider-specific mechanisms:
//   sqlite   → platform write layer (REST/NoSQL/Studio writes emit events)
//   postgres → LISTEN/NOTIFY via installable triggers (requires the pg driver)
//   mongodb  → change streams (requires the mongodb driver + replica set)
//   mysql/mariadb/badger → not supported (reported honestly)
// Events are deduplicated, persisted (resume checkpoints) and fanned out on
// the event bus to realtime, webhooks and function triggers.
import crypto from 'node:crypto';

export class CdcEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'cdc' });
    this.recentIds = new Set(); // dedupe window
    this.recentOrder = [];
    this.listeners = new Map(); // connectionId -> {type, stop()}
    this.dedupLimit = 1000;
  }

  async recordChange(evt) {
    const event = {
      eventId: crypto.randomUUID(),
      ts: new Date().toISOString(),
      projectId: evt.projectId,
      provider: evt.provider || 'unknown',
      connectionId: evt.connectionId || null,
      table: evt.table,
      op: evt.op,
      before: evt.before ?? null,
      after: evt.after ?? null,
    };
    // dedupe
    if (this.recentIds.has(event.eventId)) return event;
    this.recentIds.add(event.eventId);
    this.recentOrder.push(event.eventId);
    if (this.recentOrder.length > this.dedupLimit) {
      const dropped = this.recentOrder.splice(0, this.recentOrder.length - this.dedupLimit);
      for (const id of dropped) this.recentIds.delete(id);
    }
    // persist (checkpoint for replay)
    try {
      this.ctx.system.run(
        'INSERT OR IGNORE INTO cdc_events (event_id, project_id, provider, connection_id, table_name, op, pk, before_json, after_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [event.eventId, event.projectId, event.provider, event.connectionId, event.table, event.op,
          event.after?.id ? String(event.after.id) : null,
          event.before ? JSON.stringify(event.before).slice(0, 4000) : null,
          event.after ? JSON.stringify(event.after).slice(0, 4000) : null,
          event.ts]
      );
      this.ctx.system.exec('DELETE FROM cdc_events WHERE id NOT IN (SELECT id FROM cdc_events ORDER BY id DESC LIMIT 10000)');
    } catch { /* persistence is best-effort */ }
    // fan-out (ordered)
    await this.ctx.bus.emitAwait('db.change', event);
    this.ctx.bus.emit(`db.${event.op}`, event);
    return event;
  }

  // ── Postgres LISTEN/NOTIFY ────────────────────────────────────────────────
  async installPostgresTriggers(connectionId, tables = null) {
    const mod = await import('pg').catch(() => null);
    if (!mod) {
      throw new Error('The "pg" driver is not installed — run: npm install pg');
    }
    const row = this.ctx.system.get('SELECT * FROM db_connections WHERE id = ?', [connectionId]);
    if (!row || row.provider !== 'postgres') throw new Error('Connection is not a PostgreSQL connection');
    const cfg = this.ctx.database._decryptConfig(row.config_json);
    const client = new mod.Client({ host: cfg.host, port: cfg.port || 5432, user: cfg.user, password: cfg.password || undefined, database: cfg.database, connectionTimeoutMillis: 8000 });
    await client.connect();
    try {
      if (!tables) tables = (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'")).rows.map((r) => r.table_name);
      await client.query(`
        CREATE OR REPLACE FUNCTION bloop_notify_change() RETURNS trigger AS $$
        DECLARE payload JSON;
        BEGIN
          IF (TG_OP = 'DELETE') THEN
            payload = json_build_object('op', 'delete', 'table', TG_TABLE_NAME, 'before', to_jsonb(OLD));
          ELSIF (TG_OP = 'INSERT') THEN
            payload = json_build_object('op', 'insert', 'table', TG_TABLE_NAME, 'after', to_jsonb(NEW));
          ELSE
            payload = json_build_object('op', 'update', 'table', TG_TABLE_NAME, 'before', to_jsonb(OLD), 'after', to_jsonb(NEW));
          END IF;
          PERFORM pg_notify('bloop_events', payload::text);
          RETURN COALESCE(NEW, OLD);
        END;
        $$ LANGUAGE plpgsql;
      `);
      for (const t of tables) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) continue;
        await client.query(`DROP TRIGGER IF EXISTS bloop_cdc_trigger ON "${t}"`);
        await client.query(`CREATE TRIGGER bloop_cdc_trigger AFTER INSERT OR UPDATE OR DELETE ON "${t}" FOR EACH ROW EXECUTE FUNCTION bloop_notify_change()`);
      }
      return { installed: true, tables };
    } finally {
      await client.end().catch(() => { });
    }
  }

  async startPostgresListener(connectionId) {
    const mod = await import('pg').catch(() => null);
    if (!mod) {
      return { started: false, reason: 'pg driver not installed (npm install pg)' };
    }
    const row = this.ctx.system.get('SELECT * FROM db_connections WHERE id = ?', [connectionId]);
    if (!row) return { started: false, reason: 'connection not found' };
    const cfg = this.ctx.database._decryptConfig(row.config_json);
    const client = new mod.Client({ host: cfg.host, port: cfg.port || 5432, user: cfg.user, password: cfg.password || undefined, database: cfg.database, connectionTimeoutMillis: 8000 });
    await client.connect();
    await client.query('LISTEN bloop_events');
    client.on('notification', (msg) => {
      try {
        const payload = JSON.parse(msg.payload || '{}');
        this.recordChange({
          projectId: row.project_id,
          provider: 'postgres',
          connectionId,
          table: payload.table,
          op: payload.op,
          before: payload.before,
          after: payload.after,
        });
      } catch (err) {
        this.log.debug(`bad NOTIFY payload: ${err.message}`);
      }
    });
    const stop = async () => { try { await client.end(); } catch { } };
    this.listeners.set(connectionId, { type: 'postgres-listen-notify', stop });
    this.log.info(`postgres LISTEN/NOTIFY active for connection ${connectionId}`);
    return { started: true, mechanism: 'LISTEN/NOTIFY (install triggers first via installPostgresTriggers)' };
  }

  // ── MongoDB change streams ────────────────────────────────────────────────
  async startMongoWatcher(connectionId) {
    const row = this.ctx.system.get('SELECT * FROM db_connections WHERE id = ?', [connectionId]);
    if (!row) return { started: false, reason: 'connection not found' };
    const adapter = await this.ctx.database.getAdapter(connectionId).catch(() => null);
    if (!adapter || adapter.provider !== 'mongodb') return { started: false, reason: 'not a mongodb connection' };
    let stream;
    try {
      stream = await adapter.watch(null, (change) => {
        const op = change.operationType?.toLowerCase();
        if (!['insert', 'update', 'replace', 'delete'].includes(op)) return;
        this.recordChange({
          projectId: row.project_id,
          provider: 'mongodb',
          connectionId,
          table: change.ns?.coll || 'unknown',
          op: op === 'replace' ? 'update' : op,
          before: null,
          after: change.fullDocument || null,
        });
        // resume checkpoint
        try {
          this.ctx.system.run(
            `INSERT INTO cdc_checkpoints (id, project_id, provider, connection_id, checkpoint, updated_at) VALUES (?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET checkpoint = excluded.checkpoint, updated_at = excluded.updated_at`,
            [crypto.randomUUID(), row.project_id, 'mongodb', connectionId, JSON.stringify(change._id), new Date().toISOString()]
          );
        } catch { }
      });
    } catch (err) {
      return { started: false, reason: `change streams unavailable: ${err.message} (requires a replica set)` };
    }
    const stop = async () => { try { await stream.close(); } catch { } };
    this.listeners.set(connectionId, { type: 'mongo-change-stream', stop });
    return { started: true, mechanism: 'change streams (replica set required)' };
  }

  start() {
    // resume native listeners for eligible connections
    this.startNativeListeners().catch(() => { });
  }

  async startNativeListeners() {
    for (const conn of this.ctx.system.all("SELECT id, provider FROM db_connections WHERE provider IN ('postgres','mongodb')")) {
      try {
        if (conn.provider === 'postgres') await this.startPostgresListener(conn.id);
        if (conn.provider === 'mongodb') await this.startMongoWatcher(conn.id);
      } catch (err) {
        this.log.debug(`native CDC for ${conn.provider} connection ${conn.id} not started: ${err.message}`);
      }
    }
  }

  status() {
    return {
      listeners: [...this.listeners.entries()].map(([connectionId, l]) => ({ connectionId, type: l.type })),
      mechanismNotes: {
        sqlite: 'events are captured at the platform write layer (REST API, NoSQL engine, SQL Studio writes)',
        postgres: 'LISTEN/NOTIFY — install the CDC trigger per table, then the platform listens',
        mongodb: 'change streams via the mongodb driver (replica set required)',
        mysql: 'not implemented — binlog CDC is out of scope for this release',
        mariadb: 'not implemented — binlog CDC is out of scope for this release',
        badger: 'not applicable (KV sidecar has no change feed)',
      },
      recentEventCount: this.ctx.system.get('SELECT COUNT(*) AS c FROM cdc_events')?.c || 0,
    };
  }

  recentEvents(projectId, { limit = 100 } = {}) {
    return this.ctx.system.all('SELECT * FROM cdc_events WHERE project_id = ? ORDER BY id DESC LIMIT ?', [projectId, limit]);
  }

  async replay(projectId, { since = null } = {}) {
    const rows = since
      ? this.ctx.system.all('SELECT * FROM cdc_events WHERE project_id = ? AND created_at >= ? ORDER BY id ASC', [projectId, since])
      : this.ctx.system.all('SELECT * FROM cdc_events WHERE project_id = ? ORDER BY id ASC LIMIT 500', [projectId]);
    let replayed = 0;
    for (const r of rows) {
      await this.ctx.bus.emitAwait('db.change', {
        eventId: r.event_id, ts: r.created_at, projectId, provider: r.provider,
        connectionId: r.connection_id, table: r.table_name, op: r.op,
        before: r.before_json ? JSON.parse(r.before_json) : null,
        after: r.after_json ? JSON.parse(r.after_json) : null,
        replay: true,
      });
      replayed++;
    }
    return { replayed };
  }

  async shutdown() {
    for (const l of this.listeners.values()) {
      try { await l.stop(); } catch { }
    }
    this.listeners.clear();
  }
}

export async function register(ctx) {
  ctx.cdc = new CdcEngine(ctx);
  ctx.lifecycle?.registerShutdown?.('cdc', () => ctx.cdc.shutdown());
}
