// core/middleware.js — HTTP middleware toolkit: request context, CORS,
// security headers, body parsing (JSON / urlencoded / text / multipart),
// access logging and response helpers.
import crypto from 'node:crypto';
import { asyncHandler } from './error-handler.js';

export function compose(middleware) {
  return function run(req, res, done) {
    let i = 0;
    function next(err) {
      if (err) return done(err);
      const mw = middleware[i++];
      if (!mw) return done();
      try {
        mw(req, res, next);
      } catch (e) {
        done(e);
      }
    }
    next();
  };
}

// Attaches request metadata + response helpers to every request.
export function requestContext({ requestIdHeader = 'x-request-id' } = {}) {
  return (req, res, next) => {
    req.id = crypto.randomUUID();
    req.requestId = req.id;
    req.startedAt = process.hrtime.bigint();
    req.ip =
      (req.socket.remoteAddress || '').replace('::ffff:', '') ||
      (req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : '') ||
      'unknown';
    if (req.headers[requestIdHeader]) req.clientRequestId = String(req.headers[requestIdHeader]).slice(0, 64);
    req.path = safePath(req.url);
    req.query = parseQuery(req.url);

    res.setHeader('X-Request-Id', req.id);
    res.json = (status, obj) => sendJson(res, status, obj);
    res.text = (status, body, contentType = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': contentType });
      res.end(body);
    };
    res.noContent = () => { res.writeHead(204); res.end(); };
    next();
  };
}

function safePath(url) {
  try {
    const u = new URL(url, 'http://localhost');
    return Router_normalize(u.pathname);
  } catch {
    return '/';
  }
}
function Router_normalize(p) { return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p; }

export function parseQuery(url) {
  const out = {};
  try {
    const u = new URL(url, 'http://localhost');
    for (const [k, v] of u.searchParams) {
      if (k in out) {
        if (Array.isArray(out[k])) out[k].push(v);
        else out[k] = [out[k], v];
      } else out[k] = v;
    }
  } catch { /* keep {} */ }
  return out;
}

export function sendJson(res, status, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function corsMiddleware(config) {
  const { corsOrigins = ['*'], corsMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], corsMaxAge = 86400 } = config;
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      if (corsOrigins.includes('*')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
      } else if (corsOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      } else if (matchWildcard(corsOrigins, origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
    }
    res.setHeader('Access-Control-Allow-Methods', corsMethods.join(', '));
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With, X-Bloop-Key, X-Bloop-Env, apikey, Prefer');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-Total-Count, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Content-Range');
    res.setHeader('Access-Control-Max-Age', String(corsMaxAge));
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    next();
  };
}

function matchWildcard(origins, origin) {
  for (const o of origins) {
    if (o.includes('*')) {
      const re = new RegExp('^' + o.replace(/[.+?^$|{}()[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+') + '$');
      if (re.test(origin)) return true;
    }
  }
  return false;
}

export function securityHeadersMiddleware({ isProd = true } = {}) {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '0');
    if (isProd) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  };
}

const SIZE_UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

export function parseSize(v, dflt) {
  if (typeof v === 'number') return v;
  if (!v) return dflt;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(v).trim());
  if (!m) return dflt;
  return Math.round(parseFloat(m[1]) * SIZE_UNITS[(m[2] || 'b').toLowerCase()]);
}

// Buffers the request body (with a hard size cap) and parses it based on
// content-type. Multipart bodies are stored raw and parsed lazily via
// req.parseMultipart() so large uploads only parse where needed.
export function bodyParser({ maxSize = 50 * 1024 * 1024 } = {}) {
  return (req, res, next) => {
    const ct = String(req.headers['content-type'] || '');
    req.body = undefined;
    req.rawBody = null;
    req.parseMultipart = () => parseMultipart(req.rawBody, ct);

    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > maxSize) {
      const err = new Error('Request body too large');
      err.status = 413;
      err.code = 'PAYLOAD_TOO_LARGE';
      return next(err);
    }

    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxSize) {
        aborted = true;
        const err = new Error('Request body too large');
        err.status = 413;
        err.code = 'PAYLOAD_TOO_LARGE';
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        return next(err);
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => next(err));
    req.on('end', () => {
      if (aborted) return;
      req.rawBody = Buffer.concat(chunks);
      const mime = ct.split(';')[0].trim().toLowerCase();
      try {
        if (mime === 'application/json' || mime.endsWith('+json')) {
          req.body = req.rawBody.length ? JSON.parse(req.rawBody.toString('utf8')) : {};
        } else if (mime === 'application/x-www-form-urlencoded') {
          req.body = Object.fromEntries(new URLSearchParams(req.rawBody.toString('utf8')));
        } else if (mime.startsWith('text/') || mime === 'application/sql' || mime === 'application/graphql') {
          req.body = req.rawBody.toString('utf8');
        } else {
          req.body = undefined; // binary — route handles it
        }
      } catch (err) {
        err.status = 400;
        err.code = 'INVALID_JSON';
        err.message = 'Request body is not valid JSON';
        return next(err);
      }
      next();
    });
  };
}

// Minimal RFC 7578 multipart/form-data parser (no dependencies).
export function parseMultipart(buffer, contentTypeHeader) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentTypeHeader || '');
  if (!m) throw Object.assign(new Error('Malformed multipart request: missing boundary'), { status: 400, code: 'BAD_MULTIPART' });
  const boundary = '--' + (m[1] || m[2]).trim();
  const fields = {};
  const files = [];
  const bBoundary = Buffer.from(boundary);
  let start = buffer.indexOf(bBoundary);
  if (start === -1) return { fields, files };
  start += bBoundary.length;
  while (true) {
    const next = buffer.indexOf(bBoundary, start);
    if (next === -1) break;
    // each part: \r\nheaders\r\n\r\ncontent\r\n
    let part = buffer.subarray(start, next);
    if (part[0] === 0x0d && part[1] === 0x0a) part = part.subarray(2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) { start = next + bBoundary.length; continue; }
    const headerBlock = part.subarray(0, headerEnd).toString('utf8');
    const content = part.subarray(headerEnd + 4, part.length - 2); // strip trailing \r\n
    const headers = {};
    for (const line of headerBlock.split('\r\n')) {
      const idx = line.indexOf(':');
      if (idx !== -1) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    const cd = headers['content-disposition'] || '';
    const nameM = /name="([^"]*)"/i.exec(cd);
    const fileM = /filename="([^"]*)"/i.exec(cd);
    const name = nameM ? nameM[1] : 'field';
    if (fileM) {
      files.push({
        fieldname: name,
        filename: sanitizeUploadName(fileM[1] || 'upload.bin'),
        contentType: headers['content-type'] || 'application/octet-stream',
        size: content.length,
        buffer: Buffer.from(content), // copy — underlying buffer is shared
      });
    } else {
      fields[name] = content.toString('utf8');
    }
    start = next + bBoundary.length;
    if (buffer.subarray(start, start + 2).toString() === '--') break;
  }
  return { fields, files };
}

export function sanitizeUploadName(name) {
  return String(name)
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 180) || 'file';
}

// Access logging + duration header.
export function accessLog(logger, { metrics = null, tracing = null, logRequests = true } = {}) {
  return asyncHandler(async (req, res, next) => {
    // capture the tracing context synchronously — 'finish' fires outside it
    const traceData = tracing ? tracing.current() : null;
    const finish = () => {
      res.removeListener('finish', finish);
      const durationMs = Number(process.hrtime.bigint() - req.startedAt) / 1e6;
      if (!res.headersSent) res.setHeader('X-Response-Time', `${durationMs.toFixed(1)}ms`);
      if (metrics) {
        metrics.observeRequest(req, res, durationMs);
      }
      if (logRequests) {
        logger.http('request', {
          requestId: req.id,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
          ip: req.ip,
          userAgent: (req.headers['user-agent'] || '').slice(0, 120),
        });
      }
      if (tracing) tracing.recordRequest(req, res, durationMs, traceData);
    };
    res.on('finish', finish);
    next();
  });
}
