// modules/badger-adapter.js — BadgerDB (Go) cannot be embedded in Node.
// This adapter talks to the optional BadgerDB HTTP sidecar shipped in
// docker/badger-sidecar (an isolated Go compatibility bridge, as permitted by
// the project requirements). If the sidecar is unreachable, operations fail
// with clear guidance instead of fake success.
import { BaseAdapter, registerAdapter } from './database-adapters.js';
import { AppError } from '../core/error-handler.js';

export class BadgerAdapter extends BaseAdapter {
  constructor(connectionId, config) {
    super('badger', connectionId, config);
    this.endpoint = (config.endpoint || 'http://127.0.0.1:8089').replace(/\/$/, '');
    this.apiKey = config.apiKey || '';
  }

  async _request(path, { method = 'POST', body } = {}) {
    let res;
    try {
      res = await fetch(this.endpoint + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      throw new AppError(503, 'SIDECAR_UNREACHABLE',
        `BadgerDB sidecar at ${this.endpoint} is unreachable: ${err.message}. Start it with: docker compose up badger`);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch { }
      throw new AppError(res.status === 404 ? 404 : 502, 'SIDECAR_ERROR',
        `BadgerDB sidecar returned ${res.status}: ${detail || res.statusText}`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : res.text();
  }

  async connect() {
    await this._request('/health', { method: 'GET' });
    this.connected = true;
    return this;
  }

  async disconnect() {
    this.connected = false;
  }

  async health() {
    try {
      const info = await this._request('/health', { method: 'GET' });
      return { status: 'ok', provider: 'badger', detail: info };
    } catch (err) {
      this.connected = false;
      return { status: 'down', provider: 'badger', error: err.message };
    }
  }

  capabilities() {
    return { sql: false, nosql: false, kv: true, transactions: false, branching: 'none', cdc: 'none' };
  }

  async query() {
    throw new AppError(400, 'CAPABILITY_UNSUPPORTED', 'BadgerDB is a key-value store — no SQL support. Use the KV operations (get/put/delete/scan).');
  }
  async exec() { return this.query(); }
  async listTables() {
    throw new AppError(400, 'CAPABILITY_UNSUPPORTED', 'BadgerDB has no schema. Use KV scan operations.');
  }
  async listColumns() { return []; }
  async listIndexes() { return []; }

  async kvGet(key) {
    const r = await this._request('/kv', { body: { op: 'get', key } });
    return r.found ? { key, value: r.value } : null;
  }

  async kvPut(key, value) {
    await this._request('/kv', { body: { op: 'put', key, value: String(value) } });
    return { ok: true };
  }

  async kvDelete(key) {
    await this._request('/kv', { body: { op: 'delete', key } });
    return { ok: true };
  }

  async kvScan(prefix = '', { limit = 100 } = {}) {
    const r = await this._request('/kv', { body: { op: 'scan', prefix, limit } });
    return r.items || [];
  }

  async kvCount() {
    const r = await this._request('/kv', { body: { op: 'count' } });
    return r.count ?? 0;
  }

  async dump() {
    const items = await this.kvScan('', { limit: 100000 });
    return JSON.stringify({ generatedAt: new Date().toISOString(), items }, null, 2);
  }
}

registerAdapter('badger', BadgerAdapter);

export async function register(ctx) {
  ctx.log.debug?.('badger-adapter registered (HTTP sidecar mode)');
}
