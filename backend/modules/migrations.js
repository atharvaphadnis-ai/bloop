// modules/migrations.js — version-controlled schema migrations per project.
// Files live in migrations/<project-slug>/ as <timestamp>_<name>.sql with an
// optional <timestamp>_<name>.down.sql for rollback. Applied migrations are
// checksum-tracked; drift between the file and the recorded checksum is
// reported by validate().
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { badRequest, notFound } from '../core/error-handler.js';

export class Migrations {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'migrations' });
  }

  get db() { return this.ctx.system; }

  dirFor(projectId) {
    const project = this.ctx.projects.get(projectId);
    return path.join(this.ctx.rootDir, 'migrations', project.slug);
  }

  ensureDir(projectId) {
    const dir = this.dirFor(projectId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  create(projectId, name) {
    if (!/^[a-z0-9_][a-z0-9_-]{0,60}$/i.test(name)) throw badRequest('Migration name must be alphanumeric (dashes/underscores allowed)');
    const dir = this.ensureDir(projectId);
    const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const base = `${ts}_${name}`;
    const upPath = path.join(dir, `${base}.sql`);
    const downPath = path.join(dir, `${base}.down.sql`);
    if (fs.existsSync(upPath)) throw badRequest('A migration with that timestamp already exists');
    fs.writeFileSync(upPath, `-- Migration: ${name}\n-- Project: ${projectId}\n-- Created: ${new Date().toISOString()}\n-- Write your forward schema changes below.\n\n`, 'utf8');
    fs.writeFileSync(downPath, `-- Rollback for migration: ${name}\n-- Write the inverse of the forward migration here (optional).\n-- If left empty, rollback of "${name}" is not possible and will be reported as such.\n\n`, 'utf8');
    this.ctx.audit?.record({ actor: 'system', action: 'migration.create', projectId, target: base });
    return { name: base, upFile: upPath, downFile: downPath, dir };
  }

  _listFiles(projectId) {
    const dir = this.dirFor(projectId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .sort();
  }

  list(projectId, connectionId) {
    const applied = new Map(
      this.db.all('SELECT * FROM migrations WHERE project_id = ? AND connection_id = ? ORDER BY applied_at', [projectId, connectionId])
        .map((m) => [m.filename, m])
    );
    const files = this._listFiles(projectId);
    return files.map((f) => {
      const rec = applied.get(f);
      const content = fs.readFileSync(path.join(this.dirFor(projectId), f), 'utf8');
      return {
        filename: f,
        hasDown: fs.existsSync(path.join(this.dirFor(projectId), f.replace(/\.sql$/, '.down.sql'))),
        applied: !!rec && !rec.rolled_back_at,
        appliedAt: rec?.applied_at || null,
        rolledBackAt: rec?.rolled_back_at || null,
        checksum: rec?.checksum || null,
        checksumMatches: rec ? crypto.createHash('sha256').update(content).digest('hex') === rec.checksum : null,
        sizeBytes: content.length,
      };
    });
  }

  pending(projectId, connectionId) {
    return this.list(projectId, connectionId).filter((m) => !m.applied);
  }

  preview(projectId, filename) {
    const filePath = path.join(this.dirFor(projectId), filename);
    if (!fs.existsSync(filePath)) throw notFound('Migration file not found');
    return {
      filename,
      up: fs.readFileSync(filePath, 'utf8'),
      down: fs.existsSync(filePath.replace(/\.sql$/, '.down.sql'))
        ? fs.readFileSync(filePath.replace(/\.sql$/, '.down.sql'), 'utf8') : null,
    };
  }

  async apply(projectId, connectionId, { filename = null, dryRun = false } = {}) {
    const adapter = await this.ctx.database.getAdapter(connectionId);
    let pending = this.pending(projectId, connectionId);
    if (filename) {
      const target = filename.endsWith('.sql') ? filename : filename + '.sql';
      pending = pending.filter((m) => m.filename === target);
    }
    const results = [];
    for (const m of pending) {
      const filePath = path.join(this.dirFor(projectId), m.filename);
      const sql = fs.readFileSync(filePath, 'utf8');
      if (!sql.trim() || sql.trim().startsWith('-- Migration') && sql.replace(/--[^\n]*\n/g, '').trim() === '') {
        results.push({ filename: m.filename, status: 'skipped', reason: 'migration file is empty' });
        continue;
      }
      if (dryRun) {
        results.push({ filename: m.filename, status: 'preview', sql: sql.slice(0, 2000) });
        continue;
      }
      const t0 = Date.now();
      try {
        await adapter.transaction(async (a) => { await a.executeFile(sql); });
        const checksum = crypto.createHash('sha256').update(sql).digest('hex');
        this.db.run(
          'INSERT INTO migrations (id, project_id, connection_id, name, filename, checksum, applied_at, execution_ms, status) VALUES (?,?,?,?,?,?,?,?,?)',
          [crypto.randomUUID(), projectId, connectionId, m.filename, m.filename, checksum, new Date().toISOString(), Date.now() - t0, 'applied']
        );
        this.ctx.database.logActivity(projectId, connectionId, 'migration.apply', { filename: m.filename, ms: Date.now() - t0 });
        results.push({ filename: m.filename, status: 'applied', durationMs: Date.now() - t0 });
        this.ctx.bus.emit('migration.applied', { projectId, connectionId, filename: m.filename });
      } catch (err) {
        results.push({ filename: m.filename, status: 'failed', error: err.message });
        this.log.error(`migration ${m.filename} failed: ${err.message}`);
        break; // stop on first failure — remaining migrations stay pending
      }
    }
    return { applied: results.filter((r) => r.status === 'applied').length, results };
  }

  async rollback(projectId, connectionId, { filename = null, steps = 1, dryRun = false } = {}) {
    const appliedRows = this.db.all(
      'SELECT * FROM migrations WHERE project_id = ? AND connection_id = ? AND rolled_back_at IS NULL ORDER BY applied_at DESC',
      [projectId, connectionId]
    );
    let targets = appliedRows;
    if (filename) {
      const target = filename.endsWith('.sql') ? filename : filename + '.sql';
      targets = appliedRows.filter((m) => m.filename === target);
    }
    else targets = appliedRows.slice(0, steps);
    if (!targets.length) throw badRequest('No applied migrations to roll back');
    const results = [];
    for (const rec of targets) {
      const downPath = path.join(this.dirFor(projectId), rec.filename.replace(/\.sql$/, '.down.sql'));
      if (!fs.existsSync(downPath)) {
        results.push({ filename: rec.filename, status: 'blocked', reason: 'no down migration file — rollback not possible for this migration' });
        continue;
      }
      const sql = fs.readFileSync(downPath, 'utf8');
      if (!sql.replace(/--[^\n]*/g, '').trim()) {
        results.push({ filename: rec.filename, status: 'blocked', reason: 'down migration file is empty — fill it to enable rollback' });
        continue;
      }
      if (dryRun) { results.push({ filename: rec.filename, status: 'preview', sql: sql.slice(0, 2000) }); continue; }
      const adapter = await this.ctx.database.getAdapter(connectionId);
      const t0 = Date.now();
      try {
        await adapter.transaction(async (a) => { await a.executeFile(sql); });
        this.db.run('UPDATE migrations SET rolled_back_at = ?, status = ? WHERE id = ?', [new Date().toISOString(), 'rolled-back', rec.id]);
        results.push({ filename: rec.filename, status: 'rolled-back', durationMs: Date.now() - t0 });
      } catch (err) {
        results.push({ filename: rec.filename, status: 'failed', error: err.message });
        break;
      }
    }
    return { results };
  }

  validate(projectId, connectionId) {
    const issues = [];
    for (const m of this.list(projectId, connectionId)) {
      if (m.applied && m.checksumMatches === false) {
        issues.push({ filename: m.filename, issue: 'checksum drift — the file changed after being applied' });
      }
      if (m.applied && !m.hasDown) {
        issues.push({ filename: m.filename, issue: 'applied but has no down migration (rollback unavailable)' });
      }
    }
    return { ok: issues.length === 0, issues };
  }
}

export async function register(ctx) {
  ctx.migrations = new Migrations(ctx);
}
