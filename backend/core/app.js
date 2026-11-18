// core/app.js — Bloop composition root. Builds the whole application context,
// wires every module through the lifecycle and exposes start/stop.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadEnvironment } from './environment.js';
import { loadConfig } from './config.js';
import { createLogger, RingBuffer } from './logger.js';
import { EventBus } from './event-bus.js';
import { Router } from './router.js';
import { RateLimiter, BruteForceGuard } from './rate-limiter.js';
import { ProjectManager } from './project-manager.js';
import { TenantManager } from './tenant-manager.js';
import { EnvironmentManager } from './environment-manager.js';
import { PermissionEngine } from './permission-engine.js';
import { PolicyEngine } from './policy-engine.js';
import { HealthCheck, registerCoreChecks } from './health-check.js';
import { Lifecycle } from './lifecycle.js';
import { PluginLoader } from './plugin-loader.js';
import { loadModules, loadInfrastructure } from './module-loader.js';
import { createHttpServer } from './server.js';
import { badRequest, unauthorized } from './error-handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..', '..');

export const VERSION = '1.0.0';

export async function createApp(options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const env = loadEnvironment(rootDir);
  const config = loadConfig(rootDir, env);
  const logBuffer = new RingBuffer(8000);
  const log = createLogger({
    level: config.get('logging.level', 'info'),
    pretty: env.isDevelopment,
    logDir: config.get('logging.fileLogging', true) ? path.join(env.dataDir, 'logs') : null,
    buffer: logBuffer,
  });

  const ctx = {
    rootDir,
    env,
    config,
    log,
    logBuffer,
    version: VERSION,
    startedAt: null,
    stopping: false,
    router: new Router(),
    bus: new EventBus({ logger: log }),
    rateLimiter: new RateLimiter({ logger: log }),
    bruteForce: new BruteForceGuard({ maxAttempts: 8, baseLockMs: 30_000 }),
    permissions: new PermissionEngine({ get config() { return config; } }),
    health: null,
    lifecycle: null,
  };
  ctx.health = new HealthCheck(ctx);
  ctx.lifecycle = new Lifecycle(ctx);
  ctx.permissions.ctx = ctx; // circular refs resolved post-construction
  ctx.projects = new ProjectManager(ctx);
  ctx.tenants = new TenantManager(ctx);
  ctx.environments = new EnvironmentManager(ctx);
  ctx.policies = new PolicyEngine(ctx);
  ctx.pluginLoader = new PluginLoader(ctx);

  // ── Startup sequence ──────────────────────────────────────────────────────
  ctx.lifecycle
    .registerInit('secrets-bootstrap', async () => {
      // security.js lives in infrastructure but must initialize first — it
      // provides the master key and AES-GCM used by every other module.
      // pathToFileURL is required on Windows: a raw path like H:\bloop\... is
      // parsed by the ESM loader as a URL with scheme "h:" and throws
      // ERR_UNSUPPORTED_ESM_URL_SCHEME. pathToFileURL produces file:///H:/...
      const security = await import(pathToFileURL(path.join(rootDir, 'backend', 'infrastructure', 'security.js')).href);
      await security.register(ctx);
    })
    .registerInit('modules', async () => {
      await loadModules(ctx);
    })
    .registerInit('infrastructure', async () => {
      await loadInfrastructure(ctx);
    })
    .registerInit('core-health-checks', async () => {
      registerCoreChecks(ctx);
    })
    .registerInit('plugins', async () => {
      await ctx.pluginLoader.loadAll();
    })
    .registerInit('scheduled-tasks-start', async () => {
      ctx.scheduler?.start?.();
      ctx.backupScheduler?.start?.();
      ctx.cdc?.start?.();
      ctx.database?.startHealthMonitor?.();
      ctx.observability?.startRetention?.();
    })
    .registerInit('http-server', async () => {
      ctx.httpServer = createHttpServer(ctx);
      ctx.lifecycle.registerShutdown('http-server', () =>
        new Promise((resolve) => ctx.httpServer.close(() => resolve()))
      );
    });

  ctx.lifecycle.registerShutdown('rate-limiter', () => ctx.rateLimiter.stop());
  ctx.lifecycle.registerShutdown('event-bus', () => ctx.bus.clear());

  // ── Built-in public routes ────────────────────────────────────────────────
  ctx.router.get('/health', async (req, res) => {
    const health = await ctx.health.run();
    const status = health.status === 'down' ? 503 : 200;
    res.json(status, health);
  }, { auth: 'public', name: 'health', description: 'Aggregate health probe' });

  ctx.router.get('/api/version', async (req, res) => {
    res.json(200, { name: 'bloop', version: VERSION, tagline: 'Your backend. Your rules. Your database.' });
  }, { auth: 'public' });

  // ── Graceful shutdown bookkeeping ─────────────────────────────────────────
  ctx.lifecycle.registerShutdown('scheduler', () => ctx.scheduler?.stop?.());
  ctx.lifecycle.registerShutdown('realtime', () => ctx.realtime?.shutdown?.());
  ctx.lifecycle.registerShutdown('database-connections', () => ctx.database?.shutdown?.());

  return ctx;
}

export async function startApp(options = {}) {
  const ctx = await createApp(options);
  ctx.lifecycle.installSignalHandlers();
  await ctx.lifecycle.init();
  const host = ctx.config.get('server.host', '0.0.0.0');
  const port = ctx.config.get('server.port', 8090);
  await new Promise((resolve, reject) => {
    ctx.httpServer.once('error', reject);
    ctx.httpServer.listen(port, host, () => {
      ctx.httpServer.off('error', reject);
      resolve();
    });
  });
  ctx.startedAt = Date.now();
  ctx.log.info(`┌─────────────────────────────────────────────────────`);
  ctx.log.info(`│  Bloop v${VERSION} — Your backend. Your rules. Your database.`);
  ctx.log.info(`│  Dashboard  http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`);
  ctx.log.info(`│  Health     http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/health`);
  ctx.log.info(`└─────────────────────────────────────────────────────`);
  return ctx;
}

// Guards used by admin routes in admin-api.js
export function requireAdmin(req) {
  if (!req.admin) throw unauthorized('Admin authentication required');
  return req.admin;
}
