// infrastructure/backup-manager.js — real backup artifacts: a ZIP container
// holding the project bundle, SQLite snapshots (VACUUM INTO) or SQL dumps for
// external providers, storage files and a manifest; optional AES-256-GCM
// encryption; sha256 integrity checks; verification BEFORE success is ever
// reported; restore (in-place with automatic safety backup, or to a new
// project); retention; S3 destinations.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { badRequest, notFound, AppError } from '../core/error-handler.js';
import { createZip, readZip } from './sdk-generator.js';

const MAGIC = 'BLOOPBAK';

export class BackupManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'backups' });
  }

  get db() { return this.ctx.system; }

  backupDir(projectId) {
    return path.join(this.ctx.env.backupDir, projectId);
  }

  async createBackup(projectId, { name = null, type = 'manual', encrypt = null, destination = 'local' } = {}) {
    const project = this.ctx.projects.get(projectId);
    const t0 = Date.now();
    const useEncrypt = encrypt ?? this.ctx.config.get('backups.encryptByDefault', false);
    const backupName = name || `${project.slug}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const id = crypto.randomUUID();
    this.db.run(
      "INSERT INTO backups (id, project_id, name, type, status, destination, encrypted, created_at) VALUES (?,?,?,?, 'running', ?, ?, ?)",
      [id, projectId, backupName, type, destination, useEncrypt ? 1 : 0, new Date().toISOString()]
    );
    try {
      const parts = [];
      // 1. project bundle (config, collections, functions, webhooks, policies…)
      const bundle = this.ctx.projects.exportProject(projectId);
      parts.push({ path: 'project.json', data: JSON.stringify(bundle, null, 2) });
      // 2. database contents per connection
      const connections = this.db.all('SELECT * FROM db_connections WHERE project_id = ?', [projectId]);
      const manifestConnections = [];
      for (const conn of connections) {
        const adapter = await this.ctx.database.getAdapter(conn.id);
        manifestConnections.push({ name: conn.name, provider: conn.provider, isDefault: !!conn.is_default });
        if (conn.provider === 'sqlite') {
          const cfg = JSON.parse(conn.config_json);
          if (cfg.filename && fs.existsSync(cfg.filename)) {
            const snapPath = path.join(this.ctx.env.dataDir, 'system', `backup-snap-${id}.db`);
            await adapter.backupToFile(snapPath);
            const snap = await fsp.readFile(snapPath);
            await fsp.rm(snapPath, { force: true });
            parts.push({ path: `database/${conn.name}.sqlite`, data: snap });
          }
        } else if (['postgres', 'mysql', 'mariadb'].includes(conn.provider)) {
          const dump = await adapter.dump();
          parts.push({ path: `database/${conn.name}.sql`, data: dump });
        } else if (conn.provider === 'mongodb') {
          const dump = await adapter.dump();
          parts.push({ path: `database/${conn.name}.json`, data: dump });
        } else if (conn.provider === 'badger') {
          const dump = await adapter.dump();
          parts.push({ path: `database/${conn.name}.json`, data: dump });
        }
      }
      // 3. storage files
      const storageRoot = path.join(this.ctx.env.dataDir, 'projects', projectId, 'storage');
      const storageFiles = [];
      if (fs.existsSync(storageRoot)) {
        const walk = (dir, rel = '') => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            const r = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(p, r);
            else storageFiles.push({ path: `storage/${r}`, data: fs.readFileSync(p) });
          }
        };
        walk(storageRoot);
      }
      parts.push(...storageFiles);
      // 4. manifest (what's inside — used by restore + verification)
      const manifest = {
        format: 'bloop-backup',
        version: 1,
        createdAt: new Date().toISOString(),
        projectId,
        projectName: project.name,
        connections: manifestConnections,
        storageFileCount: storageFiles.length,
        encrypted: useEncrypt,
      };
      parts.push({ path: 'manifest.json', data: JSON.stringify(manifest, null, 2) });

      let zipBuf = createZip(parts);
      if (useEncrypt) {
        zipBuf = this._encryptBuffer(zipBuf);
      }
      const dir = this.backupDir(projectId);
      await fsp.mkdir(dir, { recursive: true });
      const fileName = `${Date.now()}_${backupName}.bloopbak`;
      const filePath = path.join(dir, fileName);
      await fsp.writeFile(filePath, zipBuf);
      const checksum = crypto.createHash('sha256').update(zipBuf).digest('hex');

      // ── verification (mandatory before "success") ────────────────────────
      const verify = await this._verifyFile(filePath, useEncrypt);
      if (!verify.ok) {
        this.db.run("UPDATE backups SET status = 'failed', error = ? WHERE id = ?", [verify.error, id]);
        throw new AppError(500, 'BACKUP_VERIFY_FAILED', `Backup was written but failed verification: ${verify.error}`);
      }
      // optional destination upload
      if (destination === 's3') {
        const s3 = this.ctx.s3?.clientForProject?.(projectId) || (await this._platformS3Client());
        if (!s3) throw badRequest('S3 destination selected but no S3 credentials are configured');
        await s3.putObject(`backups/${projectId}/${fileName}`, zipBuf, 'application/octet-stream');
      }
      this.db.run(
        "UPDATE backups SET status = 'verified', size = ?, checksum = ?, entries = ?, path = ?, verified_at = ? WHERE id = ?",
        [zipBuf.length, checksum, verify.entries, filePath, new Date().toISOString(), id]
      );
      this.ctx.audit?.record({ actor: 'system', action: 'backup.created', projectId, target: backupName, meta: { size: zipBuf.length, encrypted: useEncrypt } });
      this.ctx.bus.emit('backup.verified', { projectId, backupId: id, name: backupName, size: zipBuf.length });
      this.log.info(`backup "${backupName}" verified (${(zipBuf.length / 1024).toFixed(1)} KB, ${verify.entries} entries, ${Date.now() - t0}ms)`);
      return this.get(id);
    } catch (err) {
      this.db.run("UPDATE backups SET status = 'failed', error = ? WHERE id = ?", [err.message, id]);
      throw err;
    }
  }

  async _platformS3Client() {
    const cfg = this.ctx.security.settingsGet('backups', 's3', null);
    if (!cfg) return null;
    const { S3Client } = await require0();
    return new S3Client({ ...cfg, secretAccessKey: this.ctx.security.decrypt(cfg.secretAccessKey) });
  }

  _encryptBuffer(buf) {
    const key = this.ctx.security.masterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from(MAGIC, 'ascii'), Buffer.from('0000', 'ascii'), iv, tag, ct]);
  }

  _decryptBuffer(buf) {
    if (buf.subarray(0, 8).toString('ascii') !== MAGIC) throw badRequest('File is not a Bloop backup');
    const iv = buf.subarray(12, 24);
    const tag = buf.subarray(24, 40);
    const ct = buf.subarray(40);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.ctx.security.masterKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }

  async _verifyFile(filePath, encrypted) {
    try {
      const stat = await fsp.stat(filePath);
      if (stat.size === 0) return { ok: false, error: 'backup file is empty' };
      let buf = await fsp.readFile(filePath);
      if (encrypted) {
        if (buf.subarray(0, 8).toString('ascii') !== MAGIC) return { ok: false, error: 'missing backup magic header' };
        buf = this._decryptBuffer(buf);
      }
      const entries = readZip(buf);
      if (!entries.length) return { ok: false, error: 'zip archive contains no entries' };
      const manifest = entries.find((e) => e.path === 'manifest.json');
      if (!manifest) return { ok: false, error: 'manifest.json missing from archive' };
      const parsed = JSON.parse(manifest.data.toString('utf8'));
      if (parsed.format !== 'bloop-backup') return { ok: false, error: 'manifest format mismatch' };
      // spot-check: try inflating the project bundle too
      const bundle = entries.find((e) => e.path === 'project.json');
      if (!bundle || !JSON.parse(bundle.data.toString('utf8')).format) {
        return { ok: false, error: 'project bundle unreadable' };
      }
      return { ok: true, entries: entries.length, manifest: parsed };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async verify(id) {
    const b = this.get(id);
    const result = await this._verifyFile(b.path, !!b.encrypted);
    if (result.ok) {
      this.db.run("UPDATE backups SET status = 'verified', verified_at = ? WHERE id = ?", [new Date().toISOString(), id]);
    } else {
      this.db.run("UPDATE backups SET status = 'corrupt', error = ? WHERE id = ?", [result.error, id]);
    }
    return result;
  }

  list(projectId) {
    return this.db.all('SELECT * FROM backups WHERE project_id = ? ORDER BY created_at DESC', [projectId]);
  }

  listAll() {
    return this.db.all('SELECT * FROM backups ORDER BY created_at DESC');
  }

  get(id) {
    const row = this.db.get('SELECT * FROM backups WHERE id = ?', [id]);
    if (!row) throw notFound('Backup not found');
    return row;
  }

  async delete(id) {
    const b = this.get(id);
    if (b.path) await fsp.rm(b.path, { force: true });
    if (b.destination === 's3') {
      const s3 = this.ctx.s3?.clientForProject?.(b.project_id) || (await this._platformS3Client());
      if (s3) await s3.deleteObject(`backups/${b.project_id}/${path.basename(b.path)}`).catch(() => { });
    }
    this.db.run('DELETE FROM backups WHERE id = ?', [id]);
    this.db.run('DELETE FROM restore_jobs WHERE backup_id = ?', [id]);
    return { deleted: true };
  }

  async applyRetention(projectId, { maxCount = null, days = null } = {}) {
    const cfg = this.ctx.config.get('backups.retention', { maxCount: 30, days: 90 });
    maxCount = maxCount ?? cfg.maxCount;
    days = days ?? cfg.days;
    const rows = this.list(projectId);
    let deleted = 0;
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    for (const b of rows) {
      const tooMany = maxCount && rows.indexOf(b) >= maxCount;
      const tooOld = b.created_at < cutoff;
      if (tooMany || tooOld) {
        await this.delete(b.id);
        deleted++;
      }
    }
    return { deleted };
  }

  restoreJobs(projectId) {
    return this.db.all('SELECT * FROM restore_jobs WHERE project_id = ? ORDER BY started_at DESC LIMIT 50', [projectId]);
  }

  // ── Restore ───────────────────────────────────────────────────────────────
  async restore(backupId, { mode = 'new-project', targetProjectId = null, name = null } = {}) {
    const b = this.get(backupId);
    if (b.status !== 'verified') {
      throw badRequest(`Backup is "${b.status}", not verified — run verification before restoring`);
    }
    const jobId = crypto.randomUUID();
    this.db.run(
      "INSERT INTO restore_jobs (id, backup_id, project_id, status, mode, steps_json, started_at) VALUES (?,?,?, 'running', ?, '[]', ?)",
      [jobId, backupId, targetProjectId || b.project_id, mode, new Date().toISOString()]
    );
    const steps = [];
    const addStep = async (name, fn) => {
      const t0 = Date.now();
      try {
        const result = await fn();
        steps.push({ name, status: 'ok', result, ms: Date.now() - t0 });
        this.db.run('UPDATE restore_jobs SET steps_json = ? WHERE id = ?', [JSON.stringify(steps), jobId]);
        return result;
      } catch (err) {
        steps.push({ name, status: 'failed', error: err.message, ms: Date.now() - t0 });
        this.db.run("UPDATE restore_jobs SET steps_json = ?, status = 'failed', error = ?, finished_at = ? WHERE id = ?",
          [JSON.stringify(steps), err.message, new Date().toISOString(), jobId]);
        this.ctx.bus.emit('restore.completed', { backupId, jobId, status: 'failed' });
        throw err;
      }
    };

    try {
      let buf = await fsp.readFile(b.path);
      if (b.encrypted) buf = this._decryptBuffer(buf);
      const entries = await addStep('read-backup', async () => {
        const files = readZip(buf);
        const manifest = JSON.parse(files.find((f) => f.path === 'manifest.json').data.toString('utf8'));
        return { entries: files.length, manifest };
      });
      const files = readZip(buf);

      let project;
      if (mode === 'new-project') {
        const orgId = this.db.get('SELECT id FROM projects WHERE id = ?', [b.project_id])?.org_id
          || this.db.get('SELECT id FROM organizations LIMIT 1')?.id;
        project = await addStep('create-project', async () =>
          this.ctx.projects.importProject(orgId, JSON.parse(files.find((f) => f.path === 'project.json').data.toString('utf8')), { actor: 'restore' }));
      } else {
        project = this.ctx.projects.get(targetProjectId || b.project_id);
        await addStep('safety-backup', async () =>
          this.createBackup(project.id, { name: `pre-restore-${Date.now()}`, type: 'manual' }));
      }
      const pid = project.id;

      await addStep('restore-databases', async () => {
        const restored = [];
        for (const f of files.filter((f) => f.path.startsWith('database/'))) {
          const connName = path.basename(f.path).replace(/\.(sqlite|sql|json)$/, '');
          const ext = path.extname(f.path);
          let connRow = this.db.get('SELECT * FROM db_connections WHERE project_id = ? AND name = ?', [pid, connName]);
          if (!connRow) {
            const provider = ext === '.sqlite' ? 'sqlite' : ext === '.sql' ? 'sqlite' : 'mongodb';
            const id2 = crypto.randomUUID();
            const file2 = path.join(this.ctx.projects.projectDir(pid), 'db', `${connName}.db`);
            this.db.run('INSERT INTO db_connections (id, project_id, env_id, name, provider, config_json, is_default, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
              [id2, pid, null, connName, provider, JSON.stringify({ filename: file2, embedded: provider === 'sqlite' }), 0, 'ok', new Date().toISOString()]);
            connRow = { id: id2, provider, config_json: JSON.stringify({ filename: file2 }) };
          }
          const adapter = await this.ctx.database.getAdapter(connRow.id, { fresh: true });
          if (ext === '.sqlite') {
            await adapter.disconnect();
            const cfg = JSON.parse(connRow.config_json);
            await fsp.writeFile(cfg.filename, f.data);
            await this.ctx.database.getAdapter(connRow.id, { fresh: true });
          } else {
            await adapter.executeFile(f.data.toString('utf8'));
          }
          restored.push(connName);
        }
        return restored;
      });

      await addStep('restore-storage', async () => {
        let count = 0;
        for (const f of files.filter((f) => f.path.startsWith('storage/'))) {
          const rel = f.path.slice('storage/'.length);
          const dest = path.join(this.ctx.projects.projectDir(pid), 'storage', rel);
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.writeFile(dest, f.data);
          count++;
        }
        return { files: count };
      });

      await addStep('restore-metadata', async () => {
        // documents for the embedded document store arrive via project.json (imported above)
        const bundle = JSON.parse(files.find((f) => f.path === 'project.json').data.toString('utf8'));
        return { collections: (bundle.collections || []).length, documents: (bundle.documents || []).length, functions: (bundle.functions || []).length };
      });

      this.db.run("UPDATE restore_jobs SET status = 'completed', finished_at = ? WHERE id = ?", [new Date().toISOString(), jobId]);
      this.db.run('UPDATE backups SET restore_tested_at = ? WHERE id = ?', [new Date().toISOString(), backupId]);
      this.ctx.audit?.record({ actor: 'system', action: 'restore.completed', projectId: pid, target: b.name, meta: { mode } });
      this.ctx.bus.emit('restore.completed', { backupId, jobId, status: 'completed', projectId: pid });
      return { jobId, projectId: pid, steps };
    } catch (err) {
      throw err;
    }
  }

  async downloadFile(id) {
    const b = this.get(id);
    if (!b.path || !fs.existsSync(b.path)) throw notFound('Backup file is missing from disk');
    return { path: b.path, buffer: await fsp.readFile(b.path) };
  }
}

// avoid a require() in ESM: dynamic import helper for the S3 client class
async function require0() {
  const { S3Client } = await import('./s3-provider.js');
  return { S3Client };
}

export async function register(ctx) {
  ctx.backups = new BackupManager(ctx);
}
