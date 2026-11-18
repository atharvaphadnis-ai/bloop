// core/server.js — HTTP server assembly: async middleware pipeline, static
// frontend serving, request timeouts and WebSocket upgrade dispatch.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  requestContext, corsMiddleware, securityHeadersMiddleware, bodyParser, accessLog,
} from './middleware.js';
import { errorMiddleware, notFoundMiddleware, serializeError, AppError } from './error-handler.js';
import { Router } from './router.js';

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(frontendDir, req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    pathname = '/';
  }
  let filePath = path.normalize(path.join(frontendDir, pathname === '/' ? 'index.html' : pathname));
  if (!filePath.startsWith(path.normalize(frontendDir))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    // SPA fallback: unknown non-asset GET paths render the dashboard shell
    filePath = path.join(frontendDir, 'index.html');
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('frontend not built');
    }
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = STATIC_MIME[ext] || 'application/octet-stream';
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': body.length,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function createHttpServer(ctx) {
  const maxBodySize = ctx.config.get('security.maxBodySize', 50 * 1024 * 1024);
  const frontendDir = path.join(ctx.rootDir, 'frontend');

  const errorHandler = errorMiddleware(ctx.log);
  const notFoundHandler = notFoundMiddleware(ctx.log);

  const preMiddleware = [
    requestContext(),
    securityHeadersMiddleware({ isProd: ctx.env.isProduction }),
    corsMiddleware({
      corsOrigins: ctx.config.get('security.corsOrigins', ['*']),
      corsMethods: ctx.config.get('security.corsMethods', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
      corsMaxAge: ctx.config.get('security.corsMaxAge', 86400),
    }),
    accessLog(ctx.log, {
      get metrics() { return ctx.metrics ?? null; },
      get tracing() { return ctx.tracing ?? null; },
      logRequests: ctx.config.get('observability.requestLog', true),
    }),
    rateLimitMiddleware(ctx),
    bodyParser({ maxSize: maxBodySize }),
  ];

  async function dispatch(req, res) {
    let idx = -1;
    const run = async (i, err) => {
      if (res.writableEnded) return;
      if (err) return errorHandler(err, req, res);
      idx = i;
      if (i >= preMiddleware.length) return routeOrStatic(req, res);
      await preMiddleware[i](req, res, (e) => run(i + 1, e));
    };
    await run(0);
  }

  async function routeOrStatic(req, res) {
    const normalized = Router.normalize(req.path || '/');
    const match = ctx.router.match(req.method, normalized);
    if (!match) {
      // Segment-precise namespace checks: "/api/..." and "/realtime/..." belong
      // to the API and must never SPA-fallback to index.html. But assets like
      // /api-explorer.js and /realtime.js are static files and MUST be served —
      // a startsWith('/api') check here 404s them and breaks the ES-module graph.
      const isApiNs = normalized === '/api' || normalized.startsWith('/api/');
      const isRtNs = normalized === '/realtime' || normalized.startsWith('/realtime/');
      if ((req.method === 'GET' || req.method === 'HEAD') && !isApiNs && !isRtNs) {
        return serveStatic(frontendDir, req, res);
      }
      return notFoundHandler(req, res);
    }
    if (match.methodMismatch) {
      res.setHeader('Allow', match.route.method);
      return errorHandler(new AppError(405, 'METHOD_NOT_ALLOWED', `${req.method} is not allowed for ${normalized}`), req, res);
    }
    req.params = match.params;
    req.route = match.route;
    try {
      await applyAuth(ctx, req, res);
      if (res.writableEnded) return; // auth guard may have replied directly
      await match.route.handler(req, res);
    } catch (err) {
      errorHandler(err, req, res);
    }
  }

  const server = http.createServer((req, res) => {
    const handle = () => {
      dispatch(req, res).catch((err) => {
        ctx.log.error('dispatch crash', { message: err?.message, stack: err?.stack?.split('\n').slice(0, 5) });
        try { errorHandler(err, req, res); } catch { /* socket dead */ }
      });
    };
    if (ctx.tracing) ctx.tracing.runWithRequest(req, res, handle);
    else handle();
  });

  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 15_000;
  server.maxHeadersCount = 100;

  server.on('upgrade', (req, socket, head) => {
    const rtPath = ctx.config.get('realtime.path', '/realtime/v1');
    if (ctx.realtime && req.url && req.url.split('?')[0] === rtPath) {
      ctx.realtime.handleUpgrade(req, socket, head);
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

function rateLimitMiddleware(ctx) {
  const globalCfg = ctx.config.get('security.rateLimit', { max: 600, windowMs: 60000 });
  return (req, res, next) => {
    const normalized = req.path || '/';
    const isApiNs = normalized === '/api' || normalized.startsWith('/api/');
    const isRtNs = normalized === '/realtime' || normalized.startsWith('/realtime/');
    if (!isApiNs && !isRtNs) return next();
    // generous global ceiling per IP; fine-grained limits apply per route/key
    const result = ctx.rateLimiter.check(`ip:${req.ip}`, globalCfg);
    res.setHeader('X-RateLimit-Limit', String(result.limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
    if (!result.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      return errorHandler(new AppError(429, 'RATE_LIMITED', 'Too many requests — slow down', { retryAfterMs: result.retryAfterMs }), req, res);
    }
    next();
  };
}

// Route-level authentication. opts.auth: 'public' (default) | 'admin' | 'project' | 'cli'
async function applyAuth(ctx, req, res) {
  const auth = req.route?.opts?.auth || 'public';
  if (auth === 'admin') {
    const admin = ctx.security.verifyAdminRequest(req);
    if (!admin) {
      throw new AppError(401, 'UNAUTHORIZED', 'Admin authentication required (Authorization: Bearer <token>)');
    }
    req.admin = admin;
  } else if (auth === 'cli') {
    if (!ctx.security.verifyCliToken(req)) {
      throw new AppError(401, 'UNAUTHORIZED', 'CLI token required (Authorization: Bearer <cli-token from storage/system/cli-token>)');
    }
    req.cli = true;
  } else if (auth === 'project') {
    const principal = await ctx.authorization.resolveProjectPrincipal(req);
    if (!principal) {
      throw new AppError(401, 'UNAUTHORIZED', 'Provide a valid project API key, user JWT, or the project anon key');
    }
    req.principal = principal;
    const pid = req.params.projectId || principal.projectId;
    req.project = ctx.projects.get(pid);
  }
}
