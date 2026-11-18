// infrastructure/sdk-generator.js — generates real client SDKs (JavaScript,
// TypeScript, Python, Go, Dart) per project, plus the platform's ZIP writer
// and reader (used by backups, project export and plugin installation).
// Zero dependencies: ZIP is implemented per the PKWARE APPNOTE with zlib
// deflateRaw for compression.
import zlib from 'node:zlib';
import { badRequest } from '../core/error-handler.js';

// ── CRC32 ────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── ZIP writer ───────────────────────────────────────────────────────────────
export function createZip(files) {
  // files: [{path, data: Buffer|string}]
  const entries = [];
  const chunks = [];
  for (const file of files) {
    const nameBuf = Buffer.from(file.path, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const crc = crc32(data);
    const compressed = zlib.deflateRawSync(data, { level: 6 });
    const useDeflate = compressed.length < data.length;
    const stored = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);          // version needed
    localHeader.writeUInt16LE(0x0800, 6);      // UTF-8 flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);          // mtime
    localHeader.writeUInt16LE(0x21, 12);       // mdate (arbitrary fixed)
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(stored.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    const offset = chunks.reduce((a, c) => a + c.length, 0);
    chunks.push(localHeader, nameBuf, stored);
    entries.push({ nameBuf, crc, method, storedSize: stored.length, size: data.length, offset });
  }
  const centralStart = chunks.reduce((a, c) => a + c.length, 0);
  const centralChunks = [];
  for (const e of entries) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.storedSize, 20);
    cd.writeUInt32LE(e.size, 24);
    cd.writeUInt16LE(e.nameBuf.length, 28);
    cd.writeUInt32LE(0, 38);            // external attrs
    cd.writeUInt32LE(e.offset, 42);
    centralChunks.push(cd, e.nameBuf);
  }
  const centralSize = centralChunks.reduce((a, c) => a + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...chunks, ...centralChunks, eocd]);
}

// ── ZIP reader (used for plugin installation from .zip archives) ─────────────
export function readZip(buffer) {
  const files = [];
  // locate EOCD (scan back up to 64KB + 22)
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw badRequest('Not a valid ZIP archive (no EOCD record)');
  const count = buffer.readUInt16LE(eocdOffset + 10);
  let ptr = buffer.readUInt32LE(eocdOffset + 16);
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(ptr + 10);
    const compressedSize = buffer.readUInt32LE(ptr + 20);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localOffset = buffer.readUInt32LE(ptr + 42);
    const name = buffer.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    // local header: skip name + extra
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    let content;
    if (method === 0) content = Buffer.from(data);
    else if (method === 8) content = zlib.inflateRawSync(Buffer.from(data));
    else throw badRequest(`Unsupported ZIP compression method ${method} for entry ${name}`);
    if (!name.endsWith('/')) files.push({ path: name, data: content });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ── SDK templates ────────────────────────────────────────────────────────────
function jsSdk(baseUrl, anonKey, projectId) {
  return `/**
 * Bloop JavaScript SDK (generated) — project ${projectId}
 * Zero dependencies; uses fetch + WebSocket (Node 22+ or modern browsers).
 */
export class BloopClient {
  constructor({ baseUrl = '${baseUrl}', apiKey = '${anonKey}', projectId = '${projectId}' } = {}) {
    this.baseUrl = baseUrl.replace(/\\/$/, '');
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.accessToken = null;
    this.refreshToken = null;
  }

  async #request(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(auth ? { Authorization: \`Bearer \${this.accessToken ?? this.apiKey}\` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let detail;
      try { detail = (await res.json()).error; } catch { detail = { message: res.statusText }; }
      const err = new Error(detail?.message || 'Bloop request failed');
      err.status = res.status; err.code = detail?.code; err.details = detail?.details;
      throw err;
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : res.arrayBuffer();
  }

  // ── Authentication ──
  async register(email, password, metadata) {
    return this.#request(\`/api/v1/\${this.projectId}/auth/register\`, { method: 'POST', body: { email, password, metadata }, auth: false });
  }
  async login(email, password) {
    const r = await this.#request(\`/api/v1/\${this.projectId}/auth/login\`, { method: 'POST', body: { email, password }, auth: false });
    this.accessToken = r.accessToken; this.refreshToken = r.refreshToken;
    return r;
  }
  async refresh() {
    const r = await this.#request(\`/api/v1/\${this.projectId}/auth/refresh\`, { method: 'POST', body: { refreshToken: this.refreshToken }, auth: false });
    this.accessToken = r.accessToken; this.refreshToken = r.refreshToken;
    return r;
  }
  async me() { return this.#request(\`/api/v1/\${this.projectId}/auth/me\`); }
  async logout() {
    await this.#request(\`/api/v1/\${this.projectId}/auth/logout\`, { method: 'POST', body: { refreshToken: this.refreshToken }, auth: false });
    this.accessToken = null; this.refreshToken = null;
  }

  // ── Database (REST) ──
  from(table) {
    return new BloopQuery(this, table);
  }

  // ── NoSQL documents ──
  async collection(name) { return new BloopCollection(this, name); }

  // ── Storage ──
  async upload(bucket, file, { filename } = {}) {
    const form = new FormData();
    const blob = file instanceof Blob ? file : new Blob([file]);
    form.append('file', blob, filename || 'upload.bin');
    const res = await fetch(\`\${this.baseUrl}/api/v1/\${this.projectId}/storage/\${bucket}\`, {
      method: 'POST',
      headers: { Authorization: \`Bearer \${this.accessToken ?? this.apiKey}\` },
      body: form,
    });
    if (!res.ok) throw new Error(\`Upload failed: \${res.status}\`);
    return res.json();
  }
  async download(bucket, path) {
    const res = await fetch(\`\${this.baseUrl}/api/v1/\${this.projectId}/storage/\${bucket}/\${encodeURIComponent(path)}\`, {
      headers: { Authorization: \`Bearer \${this.accessToken ?? this.apiKey}\` },
    });
    if (!res.ok) throw new Error(\`Download failed: \${res.status}\`);
    return res.arrayBuffer();
  }

  // ── Functions ──
  async invokeFunction(slug, payload) {
    return this.#request(\`/api/v1/\${this.projectId}/functions/\${slug}\`, { method: 'POST', body: payload });
  }

  // ── GraphQL ──
  async graphql(query, variables) {
    return this.#request(\`/api/v1/\${this.projectId}/graphql\`, { method: 'POST', body: { query, variables } });
  }

  // ── Realtime ──
  realtime() { return new BloopRealtime(this); }
}

export class BloopQuery {
  constructor(client, table) {
    this.client = client; this.table = table;
    this.filters = []; this.selectColumns = null;
    this.orderBy = null; this.limitN = 50; this.offsetN = 0;
    this.wantCount = false;
  }
  select(...columns) { this.selectColumns = columns.join(','); return this; }
  eq(col, v) { this.filters.push(\`\${col}.eq=\${encodeURIComponent(v)}\`); return this; }
  neq(col, v) { this.filters.push(\`\${col}.neq=\${encodeURIComponent(v)}\`); return this; }
  gt(col, v) { this.filters.push(\`\${col}.gt=\${encodeURIComponent(v)}\`); return this; }
  gte(col, v) { this.filters.push(\`\${col}.gte=\${encodeURIComponent(v)}\`); return this; }
  lt(col, v) { this.filters.push(\`\${col}.lt=\${encodeURIComponent(v)}\`); return this; }
  lte(col, v) { this.filters.push(\`\${col}.lte=\${encodeURIComponent(v)}\`); return this; }
  like(col, v) { this.filters.push(\`\${col}.like=\${encodeURIComponent(v)}\`); return this; }
  isIn(col, values) { this.filters.push(\`\${col}.in=\${encodeURIComponent(values.join(','))}\`); return this; }
  is(col, v) { this.filters.push(\`\${col}.is=\${v}\`); return this; }
  order(col, dir = 'asc') { this.orderBy = \`\${col}.\${dir}\`; return this; }
  limit(n) { this.limitN = n; return this; }
  offset(n) { this.offsetN = n; return this; }
  count() { this.wantCount = true; return this; }
  async #build(extra = {}) {
    const params = new URLSearchParams();
    for (const f of this.filters) { const [k, ...rest] = f.split('='); params.set(k, rest.join('=')); }
    if (this.selectColumns) params.set('select', this.selectColumns);
    if (this.orderBy) params.set('order', this.orderBy);
    params.set('limit', String(this.limitN));
    params.set('offset', String(this.offsetN));
    if (this.wantCount) params.set('count', 'exact');
    for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
    const qs = params.toString();
    return this.client.#request(\`/api/v1/\${this.client.projectId}/db/\${this.table}\${qs ? '?' + qs : ''}\`);
  }
  async all() { return this.#build(); }
  async one(pk) {
    return this.client.#request(\`/api/v1/\${this.client.projectId}/db/\${this.table}/\${encodeURIComponent(pk)}\`);
  }
  async insert(rowOrRows) {
    return this.client.#request(\`/api/v1/\${this.client.projectId}/db/\${this.table}\`, { method: 'POST', body: rowOrRows });
  }
  async update(patch) {
    const qs = this.filters.map((f) => '&' + f).join('');
    return this.client.#request(\`/api/v1/\${this.client.projectId}/db/\${this.table}?limit=1\${qs}\`, { method: 'PATCH', body: patch });
  }
  async remove() {
    const qs = this.filters.map((f) => '&' + f).join('');
    return this.client.#request(\`/api/v1/\${this.client.projectId}/db/\${this.table}?limit=1\${qs}\`, { method: 'DELETE' });
  }
}

export class BloopCollection {
  constructor(client, name) { this.client = client; this.name = name; }
  async find(filter = {}, { limit = 50, skip = 0, sort = null } = {}) {
    return this.client.#request(\`/api/v1/\${this.client.projectId}/nosql/\${this.name}/find\`, { method: 'POST', body: { filter, limit, skip, sort } });
  }
  async insert(docs) {
    return this.client.#request(\`/api/v1/\${this.client.projectId}/nosql/\${this.name}\`, { method: 'POST', body: docs });
  }
  async update(filter, update, many = false) {
    return this.client.#request(\`/api/v1/\${this.client.projectId}/nosql/\${this.name}/update\`, { method: 'POST', body: { filter, update, many } });
  }
  async remove(filter, many = false) {
    return this.client.#request(\`/api/v1/\${this.client.projectId}/nosql/\${this.name}/delete\`, { method: 'POST', body: { filter, many } });
  }
  async aggregate(pipeline) {
    return this.client.#request(\`/api/v1/\${this.client.projectId}/nosql/\${this.name}/aggregate\`, { method: 'POST', body: { pipeline } });
  }
}

export class BloopRealtime {
  constructor(client) {
    this.url = client.baseUrl.replace(/^http/, 'ws') + '/realtime/v1';
    this.projectId = client.projectId;
    this.ws = null;
    this.handlers = new Map();
  }
  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      const hs = this.handlers.get(msg.channel) || [];
      for (const h of hs) h(msg);
    });
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }
  async subscribe(channel, handler) {
    if (!this.handlers.has(channel)) this.handlers.set(channel, []);
    this.handlers.get(channel).push(handler);
    this.ws.send(JSON.stringify({ op: 'subscribe', channel }));
  }
  broadcast(channel, event, payload) {
    this.ws.send(JSON.stringify({ op: 'broadcast', channel, event, payload }));
  }
  onDatabaseChange(table, handler) {
    return this.subscribe(\`project:\${this.projectId}:db:\${table}\`, handler);
  }
  close() { this.ws?.close(); }
}

export default BloopClient;
`;
}

function tsSdk(baseUrl, anonKey, projectId) {
  return `/**
 * Bloop TypeScript SDK (generated) — project ${projectId}
 */
export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  user: BloopUser;
}
export interface BloopUser {
  id: string;
  email: string;
  emailVerified: boolean;
  metadata: Record<string, unknown>;
  claims: Record<string, unknown>;
}
export interface QueryResult<T = Record<string, unknown>> {
  data: T[];
  limit: number;
  offset: number;
  count?: number;
}

export class BloopClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  constructor(
    private options: {
      baseUrl?: string;
      apiKey?: string;
      projectId?: string;
    } = {}
  ) {
    this.options.baseUrl = (options.baseUrl ?? '${baseUrl}').replace(/\\/$/, '');
    this.options.apiKey = options.apiKey ?? '${anonKey}';
    this.options.projectId = options.projectId ?? '${projectId}';
  }

  private async request<T = unknown>(
    path: string,
    init: { method?: string; body?: unknown; auth?: boolean } = {}
  ): Promise<T> {
    const { method = 'GET', body, auth = true } = init;
    const res = await fetch(\`\${this.options.baseUrl}\${path}\`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(auth ? { Authorization: \`Bearer \${this.accessToken ?? this.options.apiKey}\` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({ error: { message: res.statusText } }));
      throw new Error(detail?.error?.message ?? 'Bloop request failed');
    }
    return (await res.json()) as T;
  }

  async register(email: string, password: string, metadata?: Record<string, unknown>) {
    return this.request('/api/v1/${projectId}/auth/register', { method: 'POST', body: { email, password, metadata }, auth: false });
  }
  async login(email: string, password: string): Promise<AuthResponse> {
    const r = await this.request<AuthResponse>('/api/v1/${projectId}/auth/login', { method: 'POST', body: { email, password }, auth: false });
    this.accessToken = r.accessToken;
    this.refreshToken = r.refreshToken;
    return r;
  }
  async refreshSession(): Promise<AuthResponse> {
    const r = await this.request<AuthResponse>('/api/v1/${projectId}/auth/refresh', { method: 'POST', body: { refreshToken: this.refreshToken }, auth: false });
    this.accessToken = r.accessToken;
    this.refreshToken = r.refreshToken;
    return r;
  }
  async me(): Promise<BloopUser> {
    return this.request('/api/v1/${projectId}/auth/me');
  }

  from<T = Record<string, unknown>>(table: string): BloopQueryBuilder<T> {
    return new BloopQueryBuilder<T>(this, table);
  }

  async graphql<T = unknown>(query: string, variables?: Record<string, unknown>) {
    return this.request<{ data?: T; errors?: unknown[] }>('/api/v1/${projectId}/graphql', { method: 'POST', body: { query, variables } });
  }

  async invokeFunction<T = unknown>(slug: string, payload?: unknown) {
    return this.request<T>(\`/api/v1/\${this.options.projectId}/functions/\${slug}\`, { method: 'POST', body: payload });
  }
}

export class BloopQueryBuilder<T> {
  private filters: string[] = [];
  private orderClause: string | null = null;
  constructor(private client: BloopClient, private table: string) {}
  eq(column: keyof T & string, value: unknown): this { this.filters.push(\`\${column}.eq=\${encodeURIComponent(String(value))}\`); return this; }
  gt(column: keyof T & string, value: unknown): this { this.filters.push(\`\${column}.gt=\${encodeURIComponent(String(value))}\`); return this; }
  in(column: keyof T & string, values: unknown[]): this { this.filters.push(\`\${column}.in=\${encodeURIComponent(values.join(','))}\`); return this; }
  order(column: string, dir: 'asc' | 'desc' = 'asc'): this { this.orderClause = \`\${column}.\${dir}\`; return this; }
  limit(n: number): this { this._limit = n; return this; }
  private _limit = 50;
  private _offset = 0;
  offset(n: number): this { this._offset = n; return this; }
  async all(): Promise<QueryResult<T>> {
    const params = new URLSearchParams(this.filters.map((f) => f as [string, string]));
    if (this.orderClause) params.set('order', this.orderClause);
    params.set('limit', String(this._limit));
    params.set('offset', String(this._offset));
    return this.client.request<QueryResult<T>>(\`/api/v1/\${this.client['options'].projectId}/db/\${this.table}?\${params}\`);
  }
  async insert(row: Partial<T>): Promise<{ data: T }> {
    return this.client.request(\`/api/v1/\${this.client['options'].projectId}/db/\${this.table}\`, { method: 'POST', body: row });
  }
  async update(patch: Partial<T>): Promise<{ updated: number }> {
    const qs = this.filters.length ? '&' + this.filters.join('&') : '';
    return this.client.request(\`/api/v1/\${this.client['options'].projectId}/db/\${this.table}?limit=1\${qs}\`, { method: 'PATCH', body: patch });
  }
  async remove(): Promise<{ deleted: number }> {
    const qs = this.filters.length ? '&' + this.filters.join('&') : '';
    return this.client.request(\`/api/v1/\${this.client['options'].projectId}/db/\${this.table}?limit=1\${qs}\`, { method: 'DELETE' });
  }
}
`;
}

function pythonSdk(baseUrl, anonKey, projectId) {
  return `"""Bloop Python SDK (generated) — project ${projectId}
Requires: pip install requests
"""
from __future__ import annotations
import json
from typing import Any, Optional
from urllib.parse import quote, urlencode
import requests


class BloopError(Exception):
    def __init__(self, status: int, code: str, message: str, details=None):
        super().__init__(f"[{status}] {code}: {message}")
        self.status = status
        self.code = code
        self.details = details


class BloopClient:
    def __init__(self, base_url: str = "${baseUrl}", api_key: str = "${anonKey}", project_id: str = "${projectId}"):
        self.base_url = base_url.rstrip("/")
        self.project_id = project_id
        self.session = requests.Session()
        self.access_token: Optional[str] = None
        self.refresh_token: Optional[str] = None
        self.session.headers.update({"Authorization": f"Bearer {api_key}"})

    def _request(self, method: str, path: str, json_body: Any = None, auth: bool = True) -> Any:
        headers = {}
        if not auth and self.access_token:
            headers["Authorization"] = f"Bearer {self.access_token}"
        res = self.session.request(method, self.base_url + path, json=json_body, headers=headers, timeout=30)
        if res.status_code >= 400:
            try:
                err = res.json()["error"]
            except Exception:
                err = {"code": "UNKNOWN", "message": res.text[:300]}
            raise BloopError(res.status_code, err.get("code", "?"), err.get("message", "?"), err.get("details"))
        if res.status_code == 204:
            return None
        return res.json()

    # ── Auth ──
    def register(self, email: str, password: str, metadata: dict | None = None) -> dict:
        return self._request("POST", f"/api/v1/{self.project_id}/auth/register", {"email": email, "password": password, "metadata": metadata or {}}, auth=False)

    def login(self, email: str, password: str) -> dict:
        r = self._request("POST", f"/api/v1/{self.project_id}/auth/login", {"email": email, "password": password}, auth=False)
        self.access_token = r["accessToken"]
        self.refresh_token = r["refreshToken"]
        self.session.headers.update({"Authorization": f"Bearer {self.access_token}"})
        return r

    def refresh(self) -> dict:
        r = self._request("POST", f"/api/v1/{self.project_id}/auth/refresh", {"refreshToken": self.refresh_token}, auth=False)
        self.access_token = r["accessToken"]
        self.refresh_token = r["refreshToken"]
        self.session.headers.update({"Authorization": f"Bearer {self.access_token}"})
        return r

    def me(self) -> dict:
        return self._request("GET", f"/api/v1/{self.project_id}/auth/me")

    # ── Database ──
    def from_table(self, table: str) -> "BloopQuery":
        return BloopQuery(self, table)

    def insert(self, table: str, row: dict) -> dict:
        return self._request("POST", f"/api/v1/{self.project_id}/db/{table}", row)

    def update_row(self, table: str, filters: dict, patch: dict) -> dict:
        qs = "&".join(f"{k}={quote(str(v))}" for k, v in filters.items())
        return self._request("PATCH", f"/api/v1/{self.project_id}/db/{table}?limit=1&{qs}", patch)

    def delete_rows(self, table: str, filters: dict) -> dict:
        qs = "&".join(f"{k}={quote(str(v))}" for k, v in filters.items())
        return self._request("DELETE", f"/api/v1/{self.project_id}/db/{table}?limit=1&{qs}")

    def query(self, table: str, filters: dict | None = None, limit: int = 50, offset: int = 0,
              order: str | None = None, count: bool = False) -> dict:
        params: dict[str, Any] = {"limit": limit, "offset": offset}
        for k, v in (filters or {}).items():
            col, op = (k.split(".", 1) + ["eq"])[:2] if "." in k else (k, "eq")
            params[f"{col}.{op}"] = v
        if order:
            params["order"] = order
        if count:
            params["count"] = "exact"
        return self._request("GET", f"/api/v1/{self.project_id}/db/{table}?{urlencode(params)}")

    # ── NoSQL ──
    def nosql_find(self, collection: str, filter_: dict | None = None, limit: int = 50, skip: int = 0) -> dict:
        return self._request("POST", f"/api/v1/{self.project_id}/nosql/{collection}/find", {"filter": filter_ or {}, "limit": limit, "skip": skip})

    def nosql_insert(self, collection: str, docs: Any) -> dict:
        return self._request("POST", f"/api/v1/{self.project_id}/nosql/{collection}", docs)

    def nosql_aggregate(self, collection: str, pipeline: list) -> dict:
        return self._request("POST", f"/api/v1/{self.project_id}/nosql/{collection}/aggregate", {"pipeline": pipeline})

    # ── Storage ──
    def upload_file(self, bucket: str, path: str, filename: str | None = None, mime: str = "application/octet-stream") -> dict:
        with open(path, "rb") as fh:
            files = {"file": (filename or path.split("/")[-1], fh, mime)}
            # requests overrides Authorization for multipart; keep it manually
            headers = {"Authorization": self.session.headers.get("Authorization", "")}
            res = self.session.post(f"{self.base_url}/api/v1/{self.project_id}/storage/{bucket}", files=files, headers=headers, timeout=120)
        if res.status_code >= 400:
            raise BloopError(res.status_code, "UPLOAD_FAILED", res.text[:300])
        return res.json()

    def download_file(self, bucket: str, object_path: str, dest: str) -> str:
        res = self.session.get(f"{self.base_url}/api/v1/{self.project_id}/storage/{bucket}/{object_path}", stream=True, timeout=120)
        if res.status_code >= 400:
            raise BloopError(res.status_code, "DOWNLOAD_FAILED", res.text[:300])
        with open(dest, "wb") as fh:
            for chunk in res.iter_content(8192):
                fh.write(chunk)
        return dest

    # ── Functions & GraphQL ──
    def invoke_function(self, slug: str, payload: Any = None) -> dict:
        return self._request("POST", f"/api/v1/{self.project_id}/functions/{slug}", payload)

    def graphql(self, query: str, variables: dict | None = None) -> dict:
        return self._request("POST", f"/api/v1/{self.project_id}/graphql", {"query": query, "variables": variables or {}})
`;
}

function goSdk(baseUrl, anonKey, projectId) {
  return `// Bloop Go SDK (generated) — project ${projectId}
// Usage: client := bloop.NewClient(bloop.WithBaseURL("${baseUrl}"), bloop.WithAPIKey("${anonKey}"))
package bloop

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

type Client struct {
	BaseURL     string
	APIKey      string
	ProjectID   string
	AccessToken string
	HTTP        *http.Client
}

type Option func(*Client)

func WithBaseURL(u string) Option { return func(c *Client) { c.BaseURL = u } }
func WithAPIKey(k string) Option  { return func(c *Client) { c.APIKey = k } }

func NewClient(opts ...Option) *Client {
	c := &Client{
		BaseURL:   "${baseUrl}",
		APIKey:    "${anonKey}",
		ProjectID: "${projectId}",
		HTTP:      &http.Client{Timeout: 30 * time.Second},
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

func (c *Client) do(method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.BaseURL+path, reader)
	if err != nil {
		return err
	}
	token := c.AccessToken
	if token == "" {
		token = c.APIKey
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 400 {
		return fmt.Errorf("bloop: %s %s -> %d: %s", method, path, res.StatusCode, string(data))
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

// ── Auth ──
type AuthResponse struct {
	AccessToken  string \`json:"accessToken"\`
	RefreshToken string \`json:"refreshToken"\`
	ExpiresIn    int    \`json:"expiresIn"\`
}

func (c *Client) Register(email, password string) (map[string]any, error) {
	var out map[string]any
	err := c.do("POST", "/api/v1/"+c.ProjectID+"/auth/register", map[string]string{"email": email, "password": password}, &out)
	return out, err
}

func (c *Client) Login(email, password string) (*AuthResponse, error) {
	var out AuthResponse
	if err := c.do("POST", "/api/v1/"+c.ProjectID+"/auth/login", map[string]string{"email": email, "password": password}, &out); err != nil {
		return nil, err
	}
	c.AccessToken = out.AccessToken
	return &out, nil
}

// ── Database ──
type QueryResult struct {
	Data   []map[string]any \`json:"data"\`
	Limit  int              \`json:"limit"\`
	Offset int              \`json:"offset"\`
	Count  *int             \`json:"count,omitempty"\`
}

func (c *Client) Query(table string, filters map[string]string, limit, offset int, order string) (*QueryResult, error) {
	params := url.Values{}
	params.Set("limit", fmt.Sprint(limit))
	params.Set("offset", fmt.Sprint(offset))
	for k, v := range filters {
		params.Set(k, v)
	}
	if order != "" {
		params.Set("order", order)
	}
	var out QueryResult
	err := c.do("GET", "/api/v1/"+c.ProjectID+"/db/"+table+"?"+params.Encode(), nil, &out)
	return &out, err
}

func (c *Client) Insert(table string, row map[string]any) (map[string]any, error) {
	var out map[string]any
	err := c.do("POST", "/api/v1/"+c.ProjectID+"/db/"+table, row, &out)
	return out, err
}

func (c *Client) UpdateRow(table string, filters map[string]string, patch map[string]any) (map[string]any, error) {
	params := url.Values{}
	params.Set("limit", "1")
	for k, v := range filters {
		params.Set(k, v)
	}
	var out map[string]any
	err := c.do("PATCH", "/api/v1/"+c.ProjectID+"/db/"+table+"?"+params.Encode(), patch, &out)
	return out, err
}

func (c *Client) DeleteRow(table string, filters map[string]string) (map[string]any, error) {
	params := url.Values{}
	params.Set("limit", "1")
	for k, v := range filters {
		params.Set(k, v)
	}
	var out map[string]any
	err := c.do("DELETE", "/api/v1/"+c.ProjectID+"/db/"+table+"?"+params.Encode(), nil, &out)
	return out, err
}

// ── Functions & GraphQL ──
func (c *Client) InvokeFunction(slug string, payload any) (map[string]any, error) {
	var out map[string]any
	err := c.do("POST", "/api/v1/"+c.ProjectID+"/functions/"+slug, payload, &out)
	return out, err
}

func (c *Client) GraphQL(query string, variables map[string]any) (map[string]any, error) {
	var out map[string]any
	err := c.do("POST", "/api/v1/"+c.ProjectID+"/graphql", map[string]any{"query": query, "variables": variables}, &out)
	return out, err
}
`;
}

function dartSdk(baseUrl, anonKey, projectId) {
  return `// Bloop Dart SDK (generated) — project ${projectId}
// Requires: http package (pubspec: http: ^1.0.0)
import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;

class BloopError implements Exception {
  final int status;
  final String code;
  final String message;
  BloopError(this.status, this.code, this.message);
  @override
  String toString() => 'BloopError(\$status) \$code: \$message';
}

class BloopClient {
  final String baseUrl;
  final String projectId;
  String? accessToken;
  String? refreshToken;
  String apiKey;
  final http.Client _http = http.Client();

  BloopClient({String? baseUrl, String? apiKey, String? projectId})
      : baseUrl = (baseUrl ?? '${baseUrl}').replaceAll(RegExp(r'/\$'), ''),
        apiKey = apiKey ?? '${anonKey}',
        projectId = projectId ?? '${projectId}';

  Future<dynamic> request(String method, String path, {Object? body, bool auth = true}) async {
    final headers = <String, String>{
      if (body != null) 'Content-Type': 'application/json',
      if (auth) 'Authorization': 'Bearer \${accessToken ?? apiKey}',
    };
    final res = await _http.request(
      Uri.parse('\$baseUrl\$path'),
      method: method,
      headers: headers,
      body: body != null ? jsonEncode(body) : null,
    );
    if (res.statusCode >= 400) {
      throw BloopError(res.statusCode, 'REQUEST_FAILED', res.body.length > 300 ? res.body.substring(0, 300) : res.body);
    }
    return res.body.isEmpty ? null : jsonDecode(res.body);
  }

  // ── Auth ──
  Future<Map<String, dynamic>> register(String email, String password, {Map<String, dynamic>? metadata}) async {
    final r = await request('POST', '/api/v1/\$projectId/auth/register',
        body: {'email': email, 'password': password, 'metadata': metadata ?? {}}, auth: false);
    return r as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> login(String email, String password) async {
    final r = await request('POST', '/api/v1/\$projectId/auth/login',
        body: {'email': email, 'password': password}, auth: false) as Map<String, dynamic>;
    accessToken = r['accessToken'] as String?;
    refreshToken = r['refreshToken'] as String?;
    return r;
  }

  Future<Map<String, dynamic>> refresh() async {
    final r = await request('POST', '/api/v1/\$projectId/auth/refresh',
        body: {'refreshToken': refreshToken}, auth: false) as Map<String, dynamic>;
    accessToken = r['accessToken'] as String?;
    refreshToken = r['refreshToken'] as String?;
    return r;
  }

  Future<Map<String, dynamic>> me() async => (await request('GET', '/api/v1/\$projectId/auth/me')) as Map<String, dynamic>;

  // ── Database ──
  Future<Map<String, dynamic>> query(String table,
      {Map<String, String> filters = const {}, int limit = 50, int offset = 0, String? order}) async {
    final params = <String, String>{'limit': '\$limit', 'offset': '\$offset', ...filters};
    if (order != null) params['order'] = order;
    final qs = Uri(queryParameters: params).query;
    return (await request('GET', '/api/v1/\$projectId/db/\$table?\$qs')) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> insert(String table, Map<String, dynamic> row) async =>
      (await request('POST', '/api/v1/\$projectId/db/\$table', body: row)) as Map<String, dynamic>;

  Future<Map<String, dynamic>> update(String table, Map<String, String> filters, Map<String, dynamic> patch) async {
    final params = <String, String>{'limit': '1', ...filters};
    return (await request('PATCH', '/api/v1/\$projectId/db/\$table?\${Uri(queryParameters: params).query}', body: patch)) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> delete(String table, Map<String, String> filters) async {
    final params = <String, String>{'limit': '1', ...filters};
    return (await request('DELETE', '/api/v1/\$projectId/db/\$table?\${Uri(queryParameters: params).query}')) as Map<String, dynamic>;
  }

  // ── Storage ──
  Future<Map<String, dynamic>> upload(String bucket, String filePath, {String? filename}) async {
    final req = http.MultipartRequest('POST', Uri.parse('\$baseUrl/api/v1/\$projectId/storage/\$bucket'))
      ..headers['Authorization'] = 'Bearer \${accessToken ?? apiKey}'
      ..files.add(await http.MultipartFile.fromPath('file', filePath,
          filename: filename ?? filePath.split(Platform.pathSeparator).last));
    final res = await req.send();
    final body = await res.stream.bytesToString();
    if (res.statusCode >= 400) throw BloopError(res.statusCode, 'UPLOAD_FAILED', body);
    return jsonDecode(body) as Map<String, dynamic>;
  }

  // ── Functions & GraphQL ──
  Future<Map<String, dynamic>> invokeFunction(String slug, [Object? payload]) async =>
      (await request('POST', '/api/v1/\$projectId/functions/\$slug', body: payload)) as Map<String, dynamic>;

  Future<Map<String, dynamic>> graphql(String query, [Map<String, dynamic>? variables]) async =>
      (await request('POST', '/api/v1/\$projectId/graphql', body: {'query': query, 'variables': variables ?? {}})) as Map<String, dynamic>;
}
`;
}

export class SdkGenerator {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'sdk' });
  }

  async generate(projectId, { languages = ['javascript', 'typescript', 'python', 'go', 'dart'], baseUrl = null, anonKey = null } = {}) {
    const project = this.ctx.projects.get(projectId);
    const resolvedBase = baseUrl || this.ctx.config.get('server.publicOrigin') || `http://localhost:${this.ctx.config.get('server.port')}`;
    // anon key for generated SDKs is stored when the project is created
    const keysDir = this.ctx.security.settingsGet(`project:${projectId}`, 'bootstrapKeys', null);
    const resolvedAnon = anonKey || keysDir?.anon || 'YOUR_ANON_KEY';
    const files = [];
    const generators = {
      javascript: () => ({ path: 'bloop-js/index.js', content: jsSdk(resolvedBase, resolvedAnon, projectId) }),
      typescript: () => ({ path: 'bloop-ts/index.ts', content: tsSdk(resolvedBase, resolvedAnon, projectId) }),
      python: () => ({ path: 'bloop-python/bloop_client.py', content: pythonSdk(resolvedBase, resolvedAnon, projectId) }),
      go: () => ({ path: 'bloop-go/bloop.go', content: goSdk(resolvedBase, resolvedAnon, projectId) }),
      dart: () => ({ path: 'bloop-dart/bloop_client.dart', content: dartSdk(resolvedBase, resolvedAnon, projectId) }),
    };
    for (const lang of languages) {
      const gen = generators[lang];
      if (!gen) throw badRequest(`Unknown language "${lang}" (supported: ${Object.keys(generators).join(', ')})`);
      files.push(gen());
    }
    files.push({
      path: 'README.md',
      content: `# Generated Bloop SDK — ${project.name}

Base URL: \`${resolvedBase}\`
Project: \`${projectId}\`

| Folder | Language | Install |
|---|---|---|
| bloop-js/ | JavaScript (ESM) | copy index.js — zero dependencies |
| bloop-ts/ | TypeScript | copy index.ts |
| bloop-python/ | Python | pip install requests |
| bloop-go/ | Go | go get, then import the package |
| bloop-dart/ | Dart/Flutter | pubspec: http: ^1.0.0 |

Each SDK covers: authentication (register/login/refresh/me), database queries
(filters, ordering, pagination), storage upload/download, function invocation,
GraphQL and (JS/TS) realtime subscriptions.

## Quick start (JavaScript)
\`\`\`js
import BloopClient from './bloop-js/index.js';
const bloop = new BloopClient();
await bloop.login('user@example.com', 'password123');
const rows = await bloop.from('posts').select().eq('published', true).limit(10).all();
\`\`\`

Generated ${new Date().toISOString()} by Bloop v${this.ctx.version}.
`,
    });
    const zip = createZip(files.map((f) => ({ path: f.path, data: f.content })));
    return { files, zip, baseUrl: resolvedBase, languages };
  }

  async generateToDisk(projectId, opts) {
    const result = await this.generate(projectId, opts);
    const fs = await import('node:fs/promises');
    const outDir = `${this.ctx.rootDir}/sdk/generated/${projectId}`;
    await fs.rm(outDir, { recursive: true, force: true });
    for (const f of result.files) {
      const p = `${outDir}/${f.path}`;
      await fs.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true });
      await fs.writeFile(p, f.content, 'utf8');
    }
    return { ...result, outDir };
  }
}

export async function register(ctx) {
  ctx.sdkGenerator = new SdkGenerator(ctx);
}
