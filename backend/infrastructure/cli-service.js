// infrastructure/cli-service.js — the control-plane the Bloop CLI talks to.
// A bootstrap token is generated on first start and stored at
// storage/system/cli-token (chmod 600); every CLI request authenticates with
// it. Endpoints are intentionally machine-friendly (JSON, no HTML).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { badRequest } from '../core/error-handler.js';

export class CliService {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'cli' });
  }

  ensureToken() {
    if (!this.ctx.env.cliTokenEnabled) return null;
    const file = path.join(this.ctx.env.dataDir, 'system', 'cli-token');
    if (!fs.existsSync(file)) {
      const token = this.ctx.security.randomToken(24);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, token, { mode: 0o600 });
      try { fs.chmodSync(file, 0o600); } catch { }
      this.log.info(`CLI bootstrap token written to ${file} (chmod 600)`);
      return token;
    }
    return fs.readFileSync(file, 'utf8').trim();
  }

  status() {
    return {
      version: this.ctx.version,
      uptimeSec: Math.floor((Date.now() - (this.ctx.startedAt || Date.now())) / 1000),
      host: this.ctx.config.get('server.host'),
      port: this.ctx.config.get('server.port'),
      projects: this.ctx.system.get('SELECT COUNT(*) AS c FROM projects')?.c || 0,
      adminConfigured: (this.ctx.system.get('SELECT COUNT(*) AS c FROM admin_users')?.c || 0) > 0,
      sqliteEnabled: this.ctx.config.get('database.sqliteEnabled', true),
      realtimeConnections: this.ctx.realtime?.stats?.().connections || 0,
      dataDir: this.ctx.env.dataDir,
    };
  }

  doctor() {
    const checks = [];
    const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
    add('node-version', Number(process.versions.node.split('.')[0]) >= 22, `node ${process.versions.node} (needs >=22.5 for node:sqlite)`);
    add('system-database', !!this.ctx.system?.db, this.ctx.system?.file || '');
    try {
      this.ctx.system.exec('SELECT 1');
      add('database-writable', true);
    } catch (err) {
      add('database-writable', false, err.message);
    }
    try {
      fs.accessSync(this.ctx.env.dataDir, fs.constants.W_OK);
      add('data-dir-writable', true, this.ctx.env.dataDir);
    } catch {
      add('data-dir-writable', false, this.ctx.env.dataDir);
    }
    add('admin-user', (this.ctx.system.get('SELECT COUNT(*) AS c FROM admin_users')?.c || 0) > 0, 'run the dashboard setup on first visit');
    const projects = this.ctx.system.all('SELECT id FROM projects');
    let defaultConns = 0;
    for (const p of projects) {
      if (this.ctx.database.getDefaultConnection(p.id)) defaultConns++;
    }
    add('project-connections', defaultConns === projects.length, `${defaultConns}/${projects.length} projects have a database connection`);
    add('realtime', !!this.ctx.realtime, 'WebSocket engine loaded');
    add('scheduler', !!this.ctx.scheduler?.timer || true, 'scheduler registered');
    add('backup-dir', fs.existsSync(this.ctx.env.backupDir), this.ctx.env.backupDir);
    return {
      ok: checks.every((c) => c.ok),
      checks,
      hint: 'Fix failing checks, then restart with: bloop restart (or docker compose restart)',
    };
  }

  logs({ since = null, level = null, limit = 200 } = {}) {
    return this.ctx.observability.searchLogs({ since, level, limit });
  }
}

export async function register(ctx) {
  ctx.cliService = new CliService(ctx);
  ctx.cliService.ensureToken();
}

export function mountRoutes(ctx) {
  const r = ctx.router;
  const CLI = { auth: 'cli' };
  const svc = () => ctx.cliService;

  r.get('/api/admin/cli/ping', async (req, res) => {
    res.json(200, { pong: true, at: new Date().toISOString() });
  }, CLI);
  r.get('/api/admin/cli/status', async (req, res) => res.json(200, svc().status()), CLI);
  r.get('/api/admin/cli/doctor', async (req, res) => res.json(200, svc().doctor()), CLI);
  r.get('/api/admin/cli/logs', async (req, res) => {
    res.json(200, { logs: svc().logs({ since: req.query.since, level: req.query.level, limit: Number(req.query.limit || 200) }) });
  }, CLI);

  r.get('/api/admin/cli/projects', async (req, res) => {
    res.json(200, { projects: ctx.projects.listAll().map((p) => ({ id: p.id, name: p.name, slug: p.slug, status: p.status, createdAt: p.created_at })) });
  }, CLI);
  r.post('/api/admin/cli/projects', async (req, res) => {
    const { name, description } = req.body || {};
    const orgId = ctx.system.get('SELECT id FROM organizations ORDER BY created_at LIMIT 1')?.id
      || (await ctx.tenants.ensureDefaultOrganization());
    res.json(200, await ctx.projects.create(orgId, { name, description }));
  }, CLI);
  r.post('/api/admin/cli/projects/:id/delete', async (req, res) => {
    res.json(200, await ctx.projects.delete(req.params.id, { confirm: req.body?.confirm === true }));
  }, CLI);

  r.post('/api/admin/cli/db/backup', async (req, res) => {
    res.json(200, await ctx.backups.createBackup(req.body?.projectId, { name: req.body?.name, destination: req.body?.destination || 'local' }));
  }, CLI);
  r.post('/api/admin/cli/db/restore', async (req, res) => {
    res.json(200, await ctx.backups.restore(req.body?.backupId, { mode: req.body?.mode || 'new-project', targetProjectId: req.body?.targetProjectId }));
  }, CLI);
  r.post('/api/admin/cli/db/migrate', async (req, res) => {
    res.json(200, await ctx.migrations.apply(req.body?.projectId, req.body?.connectionId, { dryRun: req.body?.dryRun }));
  }, CLI);
  r.post('/api/admin/cli/db/rollback', async (req, res) => {
    res.json(200, await ctx.migrations.rollback(req.body?.projectId, req.body?.connectionId, { steps: req.body?.steps || 1, dryRun: req.body?.dryRun }));
  }, CLI);
  r.post('/api/admin/cli/db/seed', async (req, res) => {
    // executes a SQL seed against the project default connection
    const { projectId, sql } = req.body || {};
    if (!projectId || !sql) throw badRequest('projectId and sql are required');
    const conn = ctx.database.getDefaultConnection(projectId);
    if (!conn) throw badRequest('project has no default connection');
    res.json(200, await ctx.database.execute(conn.id, sql, [], { projectId }));
  }, CLI);
  r.post('/api/admin/cli/db/export', async (req, res) => {
    const { projectId, connectionId } = req.body || {};
    const conn = connectionId ? ctx.database.getConnection(connectionId) : ctx.database.getDefaultConnection(projectId);
    res.json(200, { connection: conn.name, dump: await ctx.database.exportDump(conn.id) });
  }, CLI);
  r.post('/api/admin/cli/db/import', async (req, res) => {
    const { projectId, connectionId, sql } = req.body || {};
    const conn = connectionId ? ctx.database.getConnection(connectionId) : ctx.database.getDefaultConnection(projectId);
    res.json(200, await ctx.database.importDump(conn.id, sql));
  }, CLI);

  r.post('/api/admin/cli/functions/deploy', async (req, res) => {
    const { projectId, slug, code, name, timeoutMs, secrets, triggers } = req.body || {};
    let fn;
    try {
      fn = ctx.functions.get(projectId, slug);
      fn = await ctx.functions.update(projectId, fn.id, { code, name, timeoutMs, secrets, triggers, enabled: true });
      res.json(200, { updated: true, function: fn });
    } catch (err) {
      if (err?.status === 404) {
        fn = await ctx.functions.create(projectId, { slug, code, name, timeoutMs, secrets, triggers, enabled: true });
        res.json(200, { created: true, function: fn });
      } else throw err;
    }
  }, CLI);
  r.get('/api/admin/cli/functions/list', async (req, res) => {
    res.json(200, { functions: ctx.functions.list(req.query.projectId) });
  }, CLI);

  r.get('/api/admin/cli/plugins', async (req, res) => {
    res.json(200, { plugins: ctx.pluginLoader.status() });
  }, CLI);
  r.post('/api/admin/cli/plugins/install', async (req, res) => {
    res.json(200, await ctx.marketplace.installFromPath(req.body?.path, { enable: req.body?.enable !== false }));
  }, CLI);

  r.post('/api/admin/cli/sdk/generate', async (req, res) => {
    const result = await ctx.sdkGenerator.generateToDisk(req.body?.projectId, {
      languages: req.body?.languages || ['javascript', 'typescript', 'python', 'go', 'dart'],
    });
    res.json(200, { outDir: result.outDir, files: result.files.map((f) => f.path), zipBase64: null });
  }, CLI);
  r.post('/api/admin/cli/sdk/generate-zip', async (req, res) => {
    const result = await ctx.sdkGenerator.generate(req.body?.projectId, req.body || {});
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="bloop-sdk-${req.body?.projectId || 'project'}.zip"`,
      'Content-Length': result.zip.length,
    });
    res.end(result.zip);
  }, CLI);
}
