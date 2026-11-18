// core/module-loader.js — loads the platform's module and infrastructure
// layers in explicit dependency order and calls register(ctx) on each.
// The file lists below are the single source of truth for module ordering.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Dependency order matters:
//  - adapter classes register themselves into the adapter registry first
//  - database.js opens the system database and exposes ctx.system
//  - feature modules register routes on ctx.router
export const MODULE_FILES = [
  'database-adapters.js',
  'sqlite-adapter.js',
  'postgres-adapter.js',
  'mysql-adapter.js',
  'mariadb-adapter.js',
  'mongodb-adapter.js',
  'badger-adapter.js',
  'connection-pool.js',
  'database.js',
  'migrations.js',
  'database-branching.js',
  'sql-editor.js',
  'nosql-engine.js',
  'authentication.js',
  'authorization.js',
  'rest-api.js',
  'graphql.js',
  'realtime.js',
  'storage.js',
  'functions.js',
];

// Infrastructure loads after modules; admin-api.js must be LAST as it mounts
// the dashboard API that references every other service.
export const INFRA_FILES = [
  'security.js',
  'metrics.js',
  'tracing.js',
  'observability.js',
  'audit-logs.js',
  'email.js',
  'oauth.js',
  'webhooks.js',
  'scheduler.js',
  's3-provider.js',
  'backup-manager.js',
  'backup-scheduler.js',
  'disaster-recovery.js',
  'cdc-engine.js',
  'cli-service.js',
  'sdk-generator.js',
  'docker-manager.js',
  'import-manager.js',
  'plugin-marketplace.js',
  'admin-api.js',
];

const CORE_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const MODULES_DIR = path.join(CORE_DIR, '..', 'modules');
const INFRA_DIR = path.join(CORE_DIR, '..', 'infrastructure');

async function importModule(file, dir = MODULES_DIR) {
  const url = pathToFileURL(path.join(dir, file)).href;
  return import(url);
}

export async function loadModules(ctx) {
  const loaded = [];
  for (const file of MODULE_FILES) {
    const t0 = Date.now();
    const mod = await importModule(file);
    if (typeof mod.register !== 'function') {
      throw new Error(`module ${file} does not export register(ctx)`);
    }
    await mod.register(ctx);
    loaded.push({ file, mod });
    ctx.log.debug(`module ${file} registered (${Date.now() - t0}ms)`);
  }
  // second pass: mount module routes now that every service exists
  for (const { file, mod } of loaded) {
    if (typeof mod.mountRoutes === 'function') {
      mod.mountRoutes(ctx);
      ctx.log.debug(`module ${file} routes mounted`);
    }
  }
}

export async function loadInfrastructure(ctx) {
  const loaded = [];
  for (const file of INFRA_FILES) {
    const t0 = Date.now();
    const mod = await importModule(file, INFRA_DIR);
    if (typeof mod.register !== 'function') {
      throw new Error(`infrastructure module ${file} does not export register(ctx)`);
    }
    await mod.register(ctx);
    loaded.push({ file, mod });
    ctx.log.debug(`infrastructure ${file} registered (${Date.now() - t0}ms)`);
  }
  for (const { file, mod } of loaded) {
    if (typeof mod.mountRoutes === 'function') {
      mod.mountRoutes(ctx);
      ctx.log.debug(`infrastructure ${file} routes mounted`);
    }
  }
}
