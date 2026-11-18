// infrastructure/webhooks.js — outbound webhooks with HMAC signatures,
// configurable timeouts, exponential-backoff retries, delivery logs and
// failure notifications. Subscriptions are bus event patterns, e.g.
// ["db.insert.*", "auth.login", "storage.object.created"].
import crypto from 'node:crypto';
import { badRequest, notFound } from '../core/error-handler.js';
import { validateOrThrow } from '../core/validation.js';

export class WebhookService {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'webhooks' });
    this.unsubs = [];
    this.pendingTimers = new Map();
  }

  get db() { return this.ctx.system; }

  create(projectId, input) {
    const data = validateOrThrow({
      name: { type: 'string', required: true, min: 1, max: 100 },
      url: { type: 'url', required: true, max: 500 },
      events: { type: 'array', required: true, min: 1, items: { type: 'string' } },
      headers: { type: 'object', default: {} },
      timeoutMs: { type: 'integer', default: 10000, min: 1000, max: 60000 },
      maxRetries: { type: 'integer', default: 5, min: 0, max: 10 },
      enabled: { type: 'boolean', default: true },
    }, input);
    const id = crypto.randomUUID();
    const secret = 'whsec_' + crypto.randomBytes(24).toString('base64url');
    this.db.run(
      'INSERT INTO webhooks (id, project_id, name, url, secret, events_json, headers_json, enabled, timeout_ms, max_retries, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, projectId, data.name, data.url, secret, JSON.stringify(data.events), JSON.stringify(data.headers), data.enabled ? 1 : 0, data.timeoutMs, data.maxRetries, new Date().toISOString(), new Date().toISOString()]
    );
    this.ctx.audit?.record({ actor: 'system', action: 'webhook.create', projectId, target: data.name });
    this.wireWebhook(id);
    const row = this.get(projectId, id);
    return { ...row, secret }; // secret returned exactly once
  }

  list(projectId) {
    return this.db.all('SELECT id, name, url, events_json, headers_json, enabled, timeout_ms, max_retries, created_at FROM webhooks WHERE project_id = ? ORDER BY created_at DESC', [projectId])
      .map((w) => ({ ...w, events: JSON.parse(w.events_json || '[]'), headers: JSON.parse(w.headers_json || '{}'), hasSecret: true }));
  }

  get(projectId, id) {
    const row = this.db.get('SELECT * FROM webhooks WHERE id = ? AND project_id = ?', [id, projectId]);
    if (!row) throw notFound('Webhook not found');
    return { ...row, events: JSON.parse(row.events_json || '[]') };
  }

  update(projectId, id, patch) {
    const row = this.get(projectId, id);
    const data = validateOrThrow({
      name: { type: 'string', min: 1, max: 100 },
      url: { type: 'url', max: 500 },
      events: { type: 'array', min: 1, items: { type: 'string' } },
      headers: { type: 'object' },
      timeoutMs: { type: 'integer', min: 1000, max: 60000 },
      maxRetries: { type: 'integer', min: 0, max: 10 },
      enabled: { type: 'boolean' },
    }, patch);
    this.db.run(
      'UPDATE webhooks SET name = ?, url = ?, events_json = ?, headers_json = ?, timeout_ms = ?, max_retries = ?, enabled = ?, updated_at = ? WHERE id = ?',
      [data.name ?? row.name, data.url ?? row.url,
        data.events ? JSON.stringify(data.events) : row.events_json,
        data.headers ? JSON.stringify(data.headers) : row.headers_json,
        data.timeoutMs ?? row.timeout_ms, data.maxRetries ?? row.max_retries,
        data.enabled !== undefined ? (data.enabled ? 1 : 0) : row.enabled,
        new Date().toISOString(), row.id]
    );
    return { id: row.id, updated: true };
  }

  delete(projectId, id) {
    this.get(projectId, id);
    this.db.run('DELETE FROM webhooks WHERE id = ?', [id]);
    this.db.run('DELETE FROM webhook_deliveries WHERE webhook_id = ?', [id]);
    return { deleted: true };
  }

  rotateSecret(projectId, id) {
    const row = this.get(projectId, id);
    const secret = 'whsec_' + crypto.randomBytes(24).toString('base64url');
    this.db.run('UPDATE webhooks SET secret = ?, updated_at = ? WHERE id = ?', [secret, new Date().toISOString(), row.id]);
    return { secret };
  }

  // ── Event wiring ──────────────────────────────────────────────────────────
  wireAll() {
    for (const row of this.db.all('SELECT id FROM webhooks WHERE enabled = 1')) {
      this.wireWebhook(row.id);
    }
    // resume interrupted retries on boot
    const pending = this.db.all("SELECT * FROM webhook_deliveries WHERE status = 'retry_scheduled' AND next_retry_at IS NOT NULL");
    for (const d of pending) {
      const delay = Math.max(0, new Date(d.next_retry_at) - Date.now());
      const timer = setTimeout(() => this.deliverDelivery(d.webhook_id, d.id), delay);
      timer.unref?.();
      this.pendingTimers.set(d.id, timer);
    }
    if (pending.length) this.log.info(`resumed ${pending.length} pending webhook retries`);
  }

  wireWebhook(webhookId) {
    const row = this.db.get('SELECT * FROM webhooks WHERE id = ?', [webhookId]);
    if (!row || !row.enabled) return;
    const events = JSON.parse(row.events_json || '[]');
    const off = this.ctx.bus.on('db.change', async (evt) => {
      // db.* events: match patterns like "db.insert.<table>" or "db.*"
      const eventName = `db.${evt.op}.${evt.table}`;
      if (!this._matches(events, eventName) && !this._matches(events, 'db.change')) return;
      await this._deliver(row, eventName, evt);
    });
    // generic event patterns (auth.*, storage.*, etc.)
    const unsub = null;
    for (const pattern of events) {
      if (pattern.startsWith('db.')) continue; // handled above via db.change
      const busOff = this.ctx.bus.on(pattern, async (payload) => {
        await this._deliver(row, pattern, payload);
      });
      this.unsubs.push({ webhookId, off: busOff });
    }
  }

  _matches(patterns, eventName) {
    return patterns.some((p) => {
      if (p === eventName) return true;
      if (p.endsWith('.*')) return eventName.startsWith(p.slice(0, -1));
      if (p === '*') return true;
      return false;
    });
  }

  async _deliver(row, eventName, payload, attempt = 1) {
    if (!row.enabled) return;
    const body = JSON.stringify({ event: eventName, payload, ts: new Date().toISOString(), webhook: row.name });
    const signature = crypto.createHmac('sha256', row.secret).update(body).digest('hex');
    const headers = {
      'Content-Type': 'application/json',
      'X-Bloop-Event': eventName,
      'X-Bloop-Signature': `sha256=${signature}`,
      'X-Bloop-Delivery-Id': crypto.randomUUID(),
      ...JSON.parse(row.headers_json || '{}'),
    };
    const deliveryId = crypto.randomUUID();
    let statusCode = null, responseBody = null, error = null, deliveredAt = null;
    try {
      const res = await fetch(row.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(row.timeout_ms || 10000),
      });
      statusCode = res.status;
      responseBody = (await res.text()).slice(0, 2000);
      if (res.ok) deliveredAt = new Date().toISOString();
      else error = `Target responded ${res.status}`;
    } catch (err) {
      error = err.message;
    }
    const status = deliveredAt ? 'delivered' : attempt <= row.max_retries ? 'retry_scheduled' : 'failed';
    let nextRetryAt = null;
    if (status === 'retry_scheduled') {
      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 300_000);
      nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
    }
    try {
      this.db.run(
        'INSERT INTO webhook_deliveries (id, webhook_id, project_id, event, payload_json, status, status_code, attempt, response_body, error, created_at, delivered_at, next_retry_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [deliveryId, row.id, row.project_id, eventName, body.slice(0, 8000), status, statusCode, attempt, responseBody, error, new Date().toISOString(), deliveredAt, nextRetryAt]
      );
    } catch (err) {
      this.log.debug(`delivery log failed: ${err.message}`);
    }
    if (status === 'retry_scheduled') {
      const delay = new Date(nextRetryAt) - Date.now();
      const timer = setTimeout(() => this._deliver(row, eventName, payload, attempt + 1), delay);
      timer.unref?.();
      this.pendingTimers.set(deliveryId, timer);
    }
    if (status === 'failed') {
      this.log.warn(`webhook "${row.name}" permanently failed after ${attempt} attempts: ${error}`);
      this.ctx.bus.emit('webhook.failed', { webhook: row.name, url: row.url, event: eventName, error, projectId: row.project_id });
    }
  }

  async deliverDelivery(webhookId, deliveryId) {
    const row = this.db.get('SELECT * FROM webhooks WHERE id = ?', [webhookId]);
    const d = this.db.get('SELECT * FROM webhook_deliveries WHERE id = ?', [deliveryId]);
    if (!row || !d) return;
    await this._deliver(row, d.event, JSON.parse(d.payload_json || '{}'), d.attempt + 1);
  }

  async retryDelivery(projectId, deliveryId) {
    const d = this.db.get('SELECT * FROM webhook_deliveries WHERE id = ? AND project_id = ?', [deliveryId, projectId]);
    if (!d) throw notFound('Delivery not found');
    const row = this.db.get('SELECT * FROM webhooks WHERE id = ?', [d.webhook_id]);
    await this._deliver(row, d.event, JSON.parse(d.payload_json || '{}'), 1);
    return { retried: true };
  }

  async testPing(projectId, id) {
    const row = this.get(projectId, id);
    await this._deliver(row, 'webhook.ping', { message: 'Bloop webhook test' }, 1);
    const latest = this.db.get('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 1', [id]);
    return { ping: latest?.status, statusCode: latest?.status_code, error: latest?.error };
  }

  deliveries(projectId, webhookId, { limit = 100 } = {}) {
    return this.db.all(
      'SELECT id, webhook_id, event, status, status_code, attempt, error, created_at, delivered_at, next_retry_at FROM webhook_deliveries WHERE project_id = ? AND webhook_id = ? ORDER BY id DESC LIMIT ?',
      [projectId, webhookId, limit]
    );
  }

  shutdown() {
    for (const t of this.pendingTimers.values()) clearTimeout(t);
    this.pendingTimers.clear();
    for (const u of this.unsubs) { try { u.off?.(); } catch { } }
    this.unsubs = [];
  }
}

export async function register(ctx) {
  ctx.webhooks = new WebhookService(ctx);
  ctx.webhooks.wireAll();
  ctx.lifecycle?.registerShutdown?.('webhooks', () => ctx.webhooks.shutdown());
}
