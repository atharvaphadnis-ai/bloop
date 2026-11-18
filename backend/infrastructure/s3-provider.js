// infrastructure/s3-provider.js — minimal S3-compatible REST client with
// AWS Signature V4 (SigV4) signing, implemented on node:crypto + fetch.
// Supports AWS S3, MinIO, Cloudflare R2 and other path-style providers.
import crypto from 'node:crypto';
import { badRequest } from '../core/error-handler.js';

export class S3Client {
  constructor({ endpoint, region = 'us-east-1', bucket, accessKeyId, secretAccessKey, forcePathStyle = true }) {
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw badRequest('S3 provider requires endpoint, bucket, accessKeyId and secretAccessKey');
    }
    this.endpoint = endpoint.replace(/\/$/, '');
    this.region = region;
    this.bucket = bucket;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.forcePathStyle = forcePathStyle;
    let host = this.endpoint;
    try { host = new URL(this.endpoint).host; } catch { }
    this.host = host;
    this.urlHost = this.forcePathStyle
      ? `${host}/${bucket}`
      : `${bucket}.${host}`;
  }

  _sign(method, pathWithQuery, headers, bodyHash) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = bodyHash || crypto.createHash('sha256').update('').digest('hex');
    const signedHeaders = Object.keys(headers).map((h) => h.toLowerCase()).sort().join(';');
    const canonicalHeaders = Object.entries(headers)
      .map(([k, v]) => [k.toLowerCase(), String(v).trim()])
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}:${v}\n`)
      .join('');
    const canonicalRequest = [
      method.toUpperCase(),
      pathWithQuery.split('?')[0],
      pathWithQuery.split('?')[1] || '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const kDate = crypto.createHmac('sha256', `AWS4${this.secretAccessKey}`).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(this.region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    return {
      authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      amzDate,
      payloadHash,
    };
  }

  async request(method, key = '', { query = {}, body = null, headers = {}, rawResponse = false } = {}) {
    const encKey = key.split('/').map(encodeURIComponent).join('/');
    const search = new URLSearchParams(query).toString();
    const pathWithQuery = `/${encKey}${search ? `?${search}` : ''}`;
    const url = `${this.forcePathStyle ? `${this.endpoint}/${this.bucket}` : `${this.endpoint}`}${pathWithQuery}`;
    const payloadHash = body
      ? crypto.createHash('sha256').update(body).digest('hex')
      : crypto.createHash('sha256').update('').digest('hex');
    const reqHeaders = {
      host: this.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': '',
      ...Object.fromEntries(Object.entries(headers)),
    };
    const { authorization, amzDate } = this._sign(method, pathWithQuery, reqHeaders, payloadHash);
    reqHeaders['x-amz-date'] = amzDate;
    reqHeaders.authorization = authorization;
    if (body) reqHeaders['content-length'] = String(body.length);

    const res = await fetch(url, {
      method,
      headers: reqHeaders,
      body: body || undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`S3 ${method} failed (${res.status}): ${text.slice(0, 400)}`);
    }
    if (rawResponse) return res;
    const ct = res.headers.get('content-type') || '';
    return ct.includes('xml') ? res.text() : Buffer.from(await res.arrayBuffer());
  }

  async putObject(key, body, contentType = 'application/octet-stream') {
    await this.request('PUT', key, { body, headers: { 'content-type': contentType } });
    return { ok: true, key };
  }

  async getObject(key) {
    const buf = await this.request('GET', key);
    return Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  }

  async deleteObject(key) {
    await this.request('DELETE', key);
    return { ok: true };
  }

  async headObject(key) {
    const res = await fetch(`${this.forcePathStyle ? `${this.endpoint}/${this.bucket}` : this.endpoint}/${key.split('/').map(encodeURIComponent).join('/')}`, { method: 'HEAD' });
    return { exists: res.ok, size: res.headers.get('content-length'), lastModified: res.headers.get('last-modified') };
  }

  async listObjectsV2(prefix = '', { maxKeys = 1000, continuationToken = null } = {}) {
    const query = { 'list-type': '2', prefix, 'max-keys': String(maxKeys) };
    if (continuationToken) query['continuation-token'] = continuationToken;
    const xml = await this.request('GET', '', { query });
    const objects = [];
    const re = /<Contents>([\s\S]*?)<\/Contents>/g;
    let m;
    while ((m = re.exec(xml))) {
      const block = m[1];
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
      const size = /<Size>([\s\S]*?)<\/Size>/.exec(block)?.[1];
      const lastModified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1];
      if (key) objects.push({ key: decodeURIComponent(key), size: Number(size || 0), lastModified });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const nextToken = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
    return { objects, truncated, nextToken };
  }

  async headBucket() {
    const res = await fetch(`${this.forcePathStyle ? `${this.endpoint}/${this.bucket}` : this.endpoint}`, { method: 'HEAD' });
    return { ok: res.ok, status: res.status };
  }

  presignGetUrl(key, { expiresSeconds = 900 } = {}) {
    const encKey = key.split('/').map(encodeURIComponent).join('/');
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const query = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresSeconds),
      'X-Amz-SignedHeaders': 'host',
    });
    const canonicalRequest = [
      'GET', `/${encKey}`, query.toString(), `host:${this.host}\n`, 'host', 'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
    const kDate = crypto.createHmac('sha256', `AWS4${this.secretAccessKey}`).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(this.region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    query.set('X-Amz-Signature', signature);
    return `${this.forcePathStyle ? `${this.endpoint}/${this.bucket}` : `${this.endpoint}`}/${encKey}?${query.toString()}`;
  }
}

export class S3ProviderService {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 's3' });
  }

  // per-project S3 config (Settings → Storage → S3 credentials, encrypted)
  saveProjectConfig(projectId, cfg) {
    const enc = {
      endpoint: cfg.endpoint,
      region: cfg.region || 'us-east-1',
      bucket: cfg.bucket,
      forcePathStyle: cfg.forcePathStyle !== false,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: this.ctx.security.encrypt(cfg.secretAccessKey),
    };
    return this.ctx.security.settingsSet(`s3:${projectId}`, 'config', enc);
  }

  getProjectConfig(projectId) {
    const cfg = this.ctx.security.settingsGet(`s3:${projectId}`, 'config', null);
    if (!cfg) return null;
    const out = { ...cfg, configured: true };
    delete out.secretAccessKey;
    return out;
  }

  clientForProject(projectId) {
    const cfg = this.ctx.security.settingsGet(`s3:${projectId}`, 'config', null);
    if (!cfg) return null;
    try {
      return new S3Client({ ...cfg, secretAccessKey: this.ctx.security.decrypt(cfg.secretAccessKey) });
    } catch (err) {
      this.log.warn(`failed to build S3 client for project ${projectId}: ${err.message}`);
      return null;
    }
  }

  async testConfig(cfg) {
    try {
      const client = new S3Client({ ...cfg, secretAccessKey: cfg.secretAccessKey });
      const head = await client.headBucket();
      return head.ok ? { ok: true } : { ok: false, error: `Bucket check returned HTTP ${head.status}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

export async function register(ctx) {
  ctx.s3 = new S3ProviderService(ctx);
}
