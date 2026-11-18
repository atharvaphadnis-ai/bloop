// modules/storage.js — buckets, uploads, downloads, signed URLs, MIME
// validation, versioning, image transformations (optional sharp driver) and
// an S3-compatible provider backend. Local filesystem is the default driver.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { badRequest, notFound, forbidden, payloadTooLarge, AppError } from '../core/error-handler.js';
import { sanitizeUploadName, parseMultipart } from '../core/middleware.js';
import { validateOrThrow } from '../core/validation.js';

const DEFAULT_MIME = 'application/octet-stream';

// magic-byte sniffing for common types (MIME headers alone are spoofable)
function sniffMime(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && (buf.subarray(0, 6).toString() === 'GIF87a' || buf.subarray(0, 6).toString() === 'GIF89a')) return 'image/gif';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) return 'application/zip';
  return null;
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export class StorageService {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'storage' });
    this._sharpModule = undefined; // lazy
  }

  get db() { return this.ctx.system; }

  bucketDir(projectId, bucketName) {
    return path.join(this.ctx.env.dataDir, 'projects', projectId, 'storage', bucketName);
  }

  // ── Buckets ───────────────────────────────────────────────────────────────
  createBucket(projectId, input) {
    const data = validateOrThrow({
      name: { type: 'string', required: true, min: 1, max: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' },
      public: { type: 'boolean', default: false },
      maxFileSize: { type: 'integer', default: 52428800, min: 1024, max: 1073741824 },
      allowedMimes: { type: 'array', default: [] },
      provider: { type: 'string', enum: ['local', 's3'], default: 'local' },
    }, input);
    const existing = this.db.get('SELECT id FROM buckets WHERE project_id = ? AND name = ?', [projectId, data.name]);
    if (existing) throw badRequest(`Bucket "${data.name}" already exists`);
    const id = crypto.randomUUID();
    this.db.run('INSERT INTO buckets (id, project_id, name, public, max_file_size, allowed_mimes, provider, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [id, projectId, data.name, data.public ? 1 : 0, data.maxFileSize, JSON.stringify(data.allowedMimes), data.provider, new Date().toISOString()]);
    if (data.provider === 'local') fs.mkdirSync(this.bucketDir(projectId, data.name), { recursive: true });
    this.ctx.audit?.record({ actor: 'system', action: 'storage.bucket.create', projectId, target: data.name });
    return this.getBucket(projectId, id);
  }

  listBuckets(projectId) {
    return this.db.all('SELECT * FROM buckets WHERE project_id = ? ORDER BY created_at', [projectId])
      .map((b) => this._decorateBucket(b));
  }

  getBucket(projectId, bucketIdOrName) {
    const b = this.db.get('SELECT * FROM buckets WHERE project_id = ? AND (id = ? OR name = ?)', [projectId, bucketIdOrName, bucketIdOrName]);
    if (!b) throw notFound('Bucket not found');
    return this._decorateBucket(b);
  }

  _decorateBucket(b) {
    const stats = this.db.get('SELECT COUNT(*) AS files, COALESCE(SUM(size),0) AS bytes FROM objects WHERE bucket_id = ? AND deleted = 0', [b.id]);
    return { ...b, public: !!b.public, stats: { files: stats.files, bytes: stats.bytes } };
  }

  updateBucket(projectId, bucketId, patch) {
    const b = this.getBucket(projectId, bucketId);
    const data = validateOrThrow({
      public: { type: 'boolean' },
      maxFileSize: { type: 'integer', min: 1024, max: 1073741824 },
      allowedMimes: { type: 'array' },
    }, patch);
    if (data.public !== undefined) this.db.run('UPDATE buckets SET public = ? WHERE id = ?', [data.public ? 1 : 0, b.id]);
    if (data.maxFileSize !== undefined) this.db.run('UPDATE buckets SET max_file_size = ? WHERE id = ?', [data.maxFileSize, b.id]);
    if (data.allowedMimes !== undefined) this.db.run('UPDATE buckets SET allowed_mimes = ? WHERE id = ?', [JSON.stringify(data.allowedMimes), b.id]);
    this.db.run('UPDATE buckets SET updated_at = ? WHERE id = ?', [new Date().toISOString(), b.id]);
    return this.getBucket(projectId, b.id);
  }

  async deleteBucket(projectId, bucketId) {
    const b = this.getBucket(projectId, bucketId);
    const count = this.db.get('SELECT COUNT(*) AS c FROM objects WHERE bucket_id = ? AND deleted = 0', [b.id])?.c || 0;
    if (count > 0) throw badRequest(`Bucket "${b.name}" still contains ${count} objects — empty it first`);
    this.db.run('DELETE FROM buckets WHERE id = ?', [b.id]);
    if (b.provider === 'local') await fsPromises.rm(this.bucketDir(projectId, b.name), { recursive: true, force: true });
    return { deleted: true };
  }

  // ── Objects ───────────────────────────────────────────────────────────────
  _validateMime(bucket, declaredMime, buffer) {
    const allowed = JSON.parse(bucket.allowed_mimes || '[]');
    const sniffed = sniffMime(buffer);
    if (allowed.length) {
      if (sniffed && !allowed.includes(sniffed)) {
        throw badRequest(`File content looks like "${sniffed}" which is not allowed in this bucket`);
      }
      if (declaredMime && !allowed.includes(declaredMime)) {
        throw badRequest(`MIME type "${declaredMime}" is not allowed in this bucket`);
      }
    }
    return sniffed || declaredMime || DEFAULT_MIME;
  }

  async upload(projectId, bucketName, { filename, buffer, mime, metadata = {} }) {
    const bucket = this.getBucket(projectId, bucketName);
    if (!buffer || !Buffer.isBuffer(buffer)) throw badRequest('Upload requires a file body');
    if (buffer.length > bucket.max_file_size) {
      throw payloadTooLarge(`File exceeds the bucket limit of ${Math.round(bucket.max_file_size / 1024 / 1024)}MB`);
    }
    const safeName = sanitizeUploadName(filename || 'upload.bin');
    const now = new Date().toISOString();
    const finalMime = this._validateMime(bucket, mime, buffer);
    const existing = this.db.get('SELECT * FROM objects WHERE bucket_id = ? AND path = ? AND deleted = 0', [bucket.id, safeName]);
    const version = existing ? existing.version + 1 : 1;
    const storageKey = `${bucket.id}/${crypto.randomUUID()}_${safeName}`;
    const etag = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);

    if (bucket.provider === 's3') {
      const s3 = this.ctx.s3?.clientForProject?.(projectId);
      if (!s3) throw badRequest('S3 provider is not configured for this project — set credentials in Settings → Storage');
      await s3.putObject(storageKey, buffer, finalMime);
    } else {
      const dir = this.bucketDir(projectId, bucket.name);
      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(path.join(dir, storageKey.replace('/', '_')), buffer);
    }

    if (existing) {
      if (existing.version >= 1) {
        // keep prior version if versioning enabled on the bucket (default on)
        this.db.run('INSERT INTO object_versions (id, object_id, project_id, version, storage_key, size, created_at) VALUES (?,?,?,?,?,?,?)',
          [crypto.randomUUID(), existing.id, projectId, existing.version, existing.storage_key, existing.size, now]);
      }
      this.db.run(
        'UPDATE objects SET storage_key = ?, mime = ?, size = ?, etag = ?, version = ?, metadata_json = ?, updated_at = ?, deleted = 0 WHERE id = ?',
        [storageKey, finalMime, buffer.length, etag, version, JSON.stringify(metadata), now, existing.id]
      );
      const obj = this.db.get('SELECT * FROM objects WHERE id = ?', [existing.id]);
      this.ctx.bus.emit('storage.object.updated', { projectId, bucket: bucket.name, path: safeName, size: buffer.length });
      return this._decorateObject(obj);
    }
    const id = crypto.randomUUID();
    this.db.run(
      'INSERT INTO objects (id, project_id, bucket_id, path, storage_key, mime, size, etag, version, metadata_json, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)',
      [id, projectId, bucket.id, safeName, storageKey, finalMime, buffer.length, etag, 1, JSON.stringify(metadata), now, now]
    );
    this.ctx.bus.emit('storage.object.created', { projectId, bucket: bucket.name, path: safeName, size: buffer.length });
    return this._decorateObject(this.db.get('SELECT * FROM objects WHERE id = ?', [id]));
  }

  _decorateObject(o) {
    return { ...o, metadata: JSON.parse(o.metadata_json || '{}') };
  }

  listObjects(projectId, bucketName, { prefix = '', limit = 100, offset = 0 } = {}) {
    const bucket = this.getBucket(projectId, bucketName);
    const rows = this.db.all(
      'SELECT * FROM objects WHERE bucket_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [bucket.id, limit, offset]
    );
    const filtered = prefix ? rows.filter((o) => o.path.startsWith(prefix)) : rows;
    return { bucket: this._decorateBucket(bucket), objects: filtered.map((o) => this._decorateObject(o)) };
  }

  async getObject(projectId, bucketName, objPath) {
    const bucket = this.getBucket(projectId, bucketName);
    const obj = this.db.get('SELECT * FROM objects WHERE bucket_id = ? AND path = ? AND deleted = 0', [bucket.id, objPath]);
    if (!obj) throw notFound('Object not found');
    let buffer;
    if (bucket.provider === 's3') {
      const s3 = this.ctx.s3?.clientForProject?.(projectId);
      if (!s3) throw badRequest('S3 provider is not configured');
      buffer = await s3.getObject(obj.storage_key);
    } else {
      const file = path.join(this.bucketDir(projectId, bucket.name), obj.storage_key.replace('/', '_'));
      try {
        buffer = await fsPromises.readFile(file);
      } catch {
        throw notFound('Object data is missing from storage (metadata exists but file is gone)');
      }
    }
    return { object: this._decorateObject(obj), bucket, buffer };
  }

  async deleteObject(projectId, bucketName, objPath) {
    const bucket = this.getBucket(projectId, bucketName);
    const obj = this.db.get('SELECT * FROM objects WHERE bucket_id = ? AND path = ? AND deleted = 0', [bucket.id, objPath]);
    if (!obj) throw notFound('Object not found');
    if (bucket.provider === 's3') {
      const s3 = this.ctx.s3?.clientForProject?.(projectId);
      if (s3) await s3.deleteObject(obj.storage_key).catch(() => { });
    } else {
      const file = path.join(this.bucketDir(projectId, bucket.name), obj.storage_key.replace('/', '_'));
      await fsPromises.rm(file, { force: true });
    }
    this.db.run('UPDATE objects SET deleted = 1, updated_at = ? WHERE id = ?', [new Date().toISOString(), obj.id]);
    this.ctx.bus.emit('storage.object.deleted', { projectId, bucket: bucket.name, path: objPath });
    return { deleted: true };
  }

  // ── Signed URLs ───────────────────────────────────────────────────────────
  signUrl(projectId, bucketName, objPath, { ttlSeconds = null } = {}) {
    const bucket = this.getBucket(projectId, bucketName);
    const ttl = ttlSeconds ?? this.ctx.config.get('storage.signedUrlTtlSeconds', 900);
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const payload = `${projectId}|${bucket.name}|${objPath}|${exp}`;
    const sig = crypto.createHmac('sha256', this.ctx.security.masterKey()).update(payload).digest('base64url');
    return {
      path: `/storage/signed?token=${Buffer.from(payload).toString('base64url')}.${sig}`,
      expiresAt: new Date(exp * 1000).toISOString(),
      ttlSeconds: ttl,
    };
  }

  verifySignedToken(token) {
    const [payloadB64, sig] = String(token || '').split('.');
    if (!payloadB64 || !sig) throw badRequest('Malformed signed-URL token');
    const payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const expected = crypto.createHmac('sha256', this.ctx.security.masterKey()).update(payload).digest('base64url');
    if (expected !== sig) throw forbidden('Signed-URL signature mismatch');
    const [projectId, bucketName, objPath, exp] = payload.split('|');
    if (Number(exp) < Math.floor(Date.now() / 1000)) throw forbidden('Signed URL has expired');
    return { projectId, bucketName, objPath };
  }

  // ── Image transformations (optional sharp driver) ─────────────────────────
  async transform(buffer, mime, { width, height, fit = 'cover', format = null, quality = 80 }) {
    if (!IMAGE_MIMES.has(mime)) throw badRequest(`Image transformations require an image (got ${mime})`);
    if (!width && !height && !format) return { buffer, mime };
    if (this._sharpModule === undefined) {
      try { this._sharpModule = await import('sharp'); } catch { this._sharpModule = null; }
    }
    if (!this._sharpModule) {
      throw new AppError(501, 'IMAGE_TRANSFORM_UNAVAILABLE',
        'Image transformations require the optional "sharp" package. Install it with: npm install sharp. The original file is returned unmodified otherwise.');
    }
    let pipeline = this._sharpModule.default(buffer);
    if (width || height) pipeline = pipeline.resize(width ? parseInt(width, 10) : null, height ? parseInt(height, 10) : null, { fit, withoutEnlargement: true });
    const outFormat = format && ['png', 'jpeg', 'webp'].includes(format) ? format : null;
    if (outFormat === 'png') pipeline = pipeline.png();
    else if (outFormat === 'webp') pipeline = pipeline.webp({ quality });
    else if (outFormat === 'jpeg' || (!outFormat && mime === 'image/jpeg')) pipeline = pipeline.jpeg({ quality });
    const out = await pipeline.toBuffer();
    return { buffer: out, mime: outFormat ? `image/${outFormat}` : mime };
  }

  usageStats(projectId) {
    const rows = this.db.all(
      `SELECT b.name, COUNT(o.id) AS files, COALESCE(SUM(o.size),0) AS bytes
       FROM buckets b LEFT JOIN objects o ON o.bucket_id = b.id AND o.deleted = 0
       WHERE b.project_id = ? GROUP BY b.id ORDER BY bytes DESC`, [projectId]
    );
    const total = rows.reduce((a, r) => a + Number(r.bytes), 0);
    return { totalBytes: total, buckets: rows };
  }
}

export async function register(ctx) {
  ctx.storage = new StorageService(ctx);
}

// ═══ Routes ═══════════════════════════════════════════════════════════════════
export function mountRoutes(ctx) {
  const S = () => ctx.storage;

  // Public / signed object delivery
  ctx.router.get('/storage/signed', async (req, res) => {
    const { projectId, bucketName, objPath } = S().verifySignedToken(req.query.token);
    const { object, buffer } = await S().getObject(projectId, bucketName, objPath);
    serveObject(req, res, object, buffer);
  }, { auth: 'public' });

  ctx.router.get('/storage/public/:projectId/:bucketName/*', async (req, res) => {
    const bucket = S().getBucket(req.params.projectId, req.params.bucketName);
    if (!bucket.public) throw forbidden('Bucket is private — use signed URLs');
    const { object, buffer } = await S().getObject(req.params.projectId, req.params.bucketName, req.params.splat);
    serveObject(req, res, object, buffer);
  }, { auth: 'public' });

  // Project REST API for storage
  ctx.router.get('/api/v1/:projectId/storage/:bucketName', async (req, res) => {
    ctx.authorization.scopeCheck(req.principal, 'storage', 'read');
    res.json(200, S().listObjects(req.params.projectId, req.params.bucketName, {
      prefix: req.query.prefix || '', limit: Math.min(Number(req.query.limit || 100), 500), offset: Number(req.query.offset || 0),
    }));
  }, { auth: 'project' });

  ctx.router.post('/api/v1/:projectId/storage/:bucketName', async (req, res) => {
    ctx.authorization.scopeCheck(req.principal, 'storage', 'write');
    const ct = String(req.headers['content-type'] || '');
    let buffer, filename, mime;
    if (ct.startsWith('multipart/form-data')) {
      const parsed = req.parseMultipart();
      const file = parsed.files[0];
      if (!file) throw badRequest('multipart upload needs a file field');
      buffer = file.buffer; filename = file.filename; mime = file.contentType;
    } else {
      if (!req.rawBody?.length) throw badRequest('Empty upload body');
      buffer = req.rawBody;
      filename = req.query.filename || 'upload.bin';
      mime = ct || undefined;
    }
    const object = await S().upload(req.params.projectId, req.params.bucketName, { filename, buffer, mime });
    res.json(201, { object });
  }, { auth: 'project' });

  ctx.router.get('/api/v1/:projectId/storage/:bucketName/*', async (req, res) => {
    ctx.authorization.scopeCheck(req.principal, 'storage', 'read');
    const { object, bucket, buffer } = await S().getObject(req.params.projectId, req.params.bucketName, req.params.splat);
    let outBuffer = buffer, outMime = object.mime;
    if (req.query.width || req.query.height || req.query.format) {
      const t = await S().transform(buffer, object.mime, req.query);
      outBuffer = t.buffer; outMime = t.mime;
    }
    serveObject(req, res, { ...object, mime: outMime }, outBuffer, { bucket, disposition: req.query.download ? 'attachment' : 'inline' });
  }, { auth: 'project' });

  ctx.router.delete('/api/v1/:projectId/storage/:bucketName/*', async (req, res) => {
    ctx.authorization.scopeCheck(req.principal, 'storage', 'write');
    res.json(200, await S().deleteObject(req.params.projectId, req.params.bucketName, req.params.splat));
  }, { auth: 'project' });

  ctx.router.post('/api/v1/:projectId/storage/:bucketName/sign', async (req, res) => {
    ctx.authorization.scopeCheck(req.principal, 'storage', 'read');
    const { path: objPath, ttlSeconds } = req.body || {};
    if (!objPath) throw badRequest('path is required');
    res.json(200, S().signUrl(req.params.projectId, req.params.bucketName, objPath, { ttlSeconds }));
  }, { auth: 'project' });
}

function serveObject(req, res, object, buffer, { disposition = 'inline' } = {}) {
  const headers = {
    'Content-Type': object.mime || DEFAULT_MIME,
    'Content-Length': buffer.length,
    'ETag': `"${object.etag || ''}"`,
    'Cache-Control': 'private, max-age=60',
    'Content-Disposition': `${disposition}; filename="${encodeURIComponent(object.path)}"`,
  };
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : buffer);
}
