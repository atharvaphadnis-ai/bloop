// core/project-manager.js — project lifecycle: creation (with isolated
// credentials, environments and a default database connection), listing,
// updates, confirmed deletion, duplication, export/import and usage stats.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { AppError, badRequest, notFound, conflict } from './error-handler.js';
import { validateOrThrow } from './validation.js';

const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomKey(bytes = 32) {
  const buf = crypto.randomBytes(bytes);
  let out = '';
  for (let i = 0; i < buf.length; i++) out += KEY_ALPHABET[buf[i] % 64];
  return out;
}

export function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project';
}

export function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export class ProjectManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'projects' });
  }

  get db() { return this.ctx.system; }

  projectDir(projectId) {
    return path.join(this.ctx.env.dataDir, 'projects', projectId);
  }

  async create(orgId, input, { actor = 'system' } = {}) {
    const data = validateOrThrow({
      name: { type: 'string', required: true, min: 2, max: 64 },
      description: { type: 'string', max: 300 },
      region: { type: 'string', default: 'local' },
    }, input);
    const id = crypto.randomUUID();
    let slug = slugify(data.name);
    if (this.db.get('SELECT id FROM projects WHERE slug = ?', [slug])) {
      slug = `${slug}-${slugify(id.slice(0, 8))}`;
    }
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO projects (id, org_id, name, slug, description, region, status, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, orgId, data.name, slug, data.description || '', data.region || 'local', 'active', now, now, actor]
    );
    await this.ctx.environments.ensureDefaultEnvironments(id);
    // default database connection (embedded SQLite) when enabled
    if (this.ctx.config.get('database.sqliteEnabled', true)) {
      const dbFile = path.join(this.projectDir(id), 'db', 'main.db');
      await fs.mkdir(path.dirname(dbFile), { recursive: true });
      this.db.run(
        'INSERT INTO db_connections (id, project_id, env_id, name, provider, config_json, is_default, created_at, status) VALUES (?,?,?,?,?,?,?,?,?)',
        [crypto.randomUUID(), id, null, 'main', 'sqlite',
          JSON.stringify({ filename: dbFile, embedded: true }), 1, now, 'ok']
      );
    }
    const keys = {
      anon: this.createApiKey(id, { name: 'anon key', type: 'anon', scopes: [{ domain: '*', actions: ['read'] }] }),
      service: this.createApiKey(id, { name: 'service_role key', type: 'service', scopes: [{ domain: '*', actions: ['*'] }] }),
    };
    // bootstrap keys are stored so the dashboard can display them later:
    // the anon key is public by design; the service key is encrypted at rest
    // and only revealed through an audited admin endpoint.
    this.ctx.security?.settingsSet?.(`project:${id}`, 'bootstrapKeys', {
      anon: keys.anon.key,
      service: this.ctx.security.encrypt(keys.service.key),
    });
    await fs.mkdir(this.projectDir(id), { recursive: true });
    this.ctx.audit?.record({ actor, action: 'project.create', target: id, projectId: id, meta: { name: data.name, org: orgId } });
    this.ctx.bus.emit('project.created', { projectId: id, orgId, name: data.name });
    this.log.info(`project created: ${data.name} (${id})`);
    return this.get(id);
  }

  list(orgId) {
    return this.db.all('SELECT * FROM projects WHERE org_id = ? ORDER BY created_at DESC', [orgId]);
  }

  listAll() {
    return this.db.all('SELECT * FROM projects ORDER BY created_at DESC');
  }

  get(id) {
    const p = this.db.get('SELECT * FROM projects WHERE id = ?', [id]);
    if (!p) throw notFound('Project not found');
    return this.decorate(p);
  }

  decorate(p) {
    if (p) {
      p.environments = this.db.all('SELECT id, name, is_default, cloned_from, created_at FROM project_environments WHERE project_id = ? ORDER BY created_at', [p.id]);
      p.connections_count = this.db.get('SELECT COUNT(*) AS c FROM db_connections WHERE project_id = ?', [p.id])?.c || 0;
      p.keys_count = this.db.get('SELECT COUNT(*) AS c FROM api_keys WHERE project_id = ? AND revoked = 0', [p.id])?.c || 0;
    }
    return p;
  }

  update(id, patch) {
    this.get(id);
    const data = validateOrThrow({
      name: { type: 'string', min: 2, max: 64 },
      description: { type: 'string', max: 300 },
      status: { type: 'string', enum: ['active', 'paused'] },
    }, patch);
    const fields = [];
    const params = [];
    for (const k of ['name', 'description', 'status']) {
      if (data[k] !== undefined) { fields.push(`${k} = ?`); params.push(data[k]); }
    }
    if (!fields.length) return this.get(id);
    fields.push('updated_at = ?');
    params.push(new Date().toISOString(), id);
    this.db.run(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`, params);
    this.ctx.bus.emit('project.updated', { projectId: id });
    return this.get(id);
  }

  async delete(id, { confirm = false } = {}) {
    this.get(id);
    if (!confirm) throw badRequest('Deletion requires confirmation. Send { "confirm": true }.');
    // cascade delete across all project-scoped tables
    const tables = [
      'projects', 'project_environments', 'env_vars', 'api_keys', 'db_connections',
      'users', 'user_identities', 'user_passkeys', 'tokens', 'sessions',
      'buckets', 'objects', 'functions', 'function_logs', 'function_executions',
      'webhooks', 'webhook_deliveries', 'scheduled_jobs', 'job_runs',
      'migrations', 'query_history', 'saved_queries', 'db_activity',
      'collection_meta', 'documents', 'document_history',
      'row_policies', 'custom_endpoints', 'oauth_configs', 'row_policies',
      'cdc_events', 'cdc_checkpoints', 'backups', 'import_jobs',
      'email_log', 'audit_logs', 'request_logs', 'auth_logs', 'realtime_channels',
    ];
    this.db.tx(() => {
      for (const t of tables) {
        try { this.db.run(`DELETE FROM ${t} WHERE project_id = ?`, [id]); } catch { /* table may not carry project_id */ }
      }
      // org-scoped tables that reference the project indirectly
      try { this.db.run('DELETE FROM backups WHERE project_id = ?', [id]); } catch { }
    });
    await fs.rm(this.projectDir(id), { recursive: true, force: true });
    this.ctx.audit?.record({ actor: 'system', action: 'project.delete', target: id, projectId: id });
    this.ctx.bus.emit('project.deleted', { projectId: id });
    this.log.info(`project deleted: ${id}`);
    return { deleted: true, id };
  }

  async duplicate(id, { name, copyData = true, copyUsers = false }) {
    const src = this.get(id);
    const created = await this.create(src.org_id, { name: name || `${src.name} copy`, description: src.description });
    // copy environments
    for (const env of src.environments || []) {
      if (['dev', 'staging', 'prod'].includes(env.name)) continue;
      this.ctx.environments.create(created.id, { name: env.name, cloneOf: null });
    }
    // copy data plane contents (sqlite default connection)
    if (copyData) {
      const srcConn = this.db.get("SELECT * FROM db_connections WHERE project_id = ? AND is_default = 1", [id]);
      if (srcConn && srcConn.provider === 'sqlite') {
        const dstConn = this.db.get("SELECT * FROM db_connections WHERE project_id = ? AND is_default = 1", [created.id]);
        if (dstConn) {
          const srcCfg = JSON.parse(srcConn.config_json || '{}');
          const dstCfg = JSON.parse(dstConn.config_json || '{}');
          if (srcCfg.filename && dstCfg.filename) {
            await fs.mkdir(path.dirname(dstCfg.filename), { recursive: true });
            await fs.copyFile(srcCfg.filename, dstCfg.filename);
          }
        }
      }
    }
    if (copyUsers) {
      for (const u of this.db.all('SELECT * FROM users WHERE project_id = ?', [id])) {
        this.db.run(
          'INSERT INTO users (id, project_id, email, password_hash, email_verified, metadata_json, created_at, disabled) VALUES (?,?,?,?,?,?,?,?)',
          [crypto.randomUUID(), created.id, u.email, u.password_hash, u.email_verified, u.metadata_json, new Date().toISOString(), u.disabled]
        );
      }
    }
    return this.get(created.id);
  }

  exportProject(id) {
    const p = this.get(id);
    const bundle = {
      format: 'bloop-project-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      project: { name: p.name, slug: p.slug, description: p.description, region: p.region },
      environments: this.db.all('SELECT name, is_default FROM project_environments WHERE project_id = ?', [id]),
      envVars: this.db.all('SELECT env_id, key FROM env_vars WHERE project_id = ?', [id]), // values are secrets: excluded
      connections: this.db.all('SELECT name, provider, is_default FROM db_connections WHERE project_id = ?', [id]),
      collections: this.db.all('SELECT name, options_json FROM collection_meta WHERE project_id = ?', [id]),
      documents: this.db.all('SELECT collection_id, data_json, created_at FROM documents WHERE project_id = ? AND deleted = 0', [id]),
      functions: this.db.all('SELECT slug, name, code, timeout_ms, triggers_json FROM functions WHERE project_id = ?', [id]),
      webhooks: this.db.all('SELECT name, url, events_json, enabled FROM webhooks WHERE project_id = ?', [id]),
      buckets: this.db.all('SELECT name, public, max_file_size, allowed_mimes, provider FROM buckets WHERE project_id = ?', [id]),
      rowPolicies: this.db.all('SELECT table_name, policy_name, command, expression, roles, enabled FROM row_policies WHERE project_id = ?', [id]),
      savedQueries: this.db.all('SELECT name, sql FROM saved_queries WHERE project_id = ?', [id]),
    };
    return bundle;
  }

  async importProject(orgId, bundle, { actor = 'api' } = {}) {
    if (bundle?.format !== 'bloop-project-export') throw badRequest('Invalid project export bundle');
    const created = await this.create(orgId, { name: bundle.project?.name || 'Imported project', description: bundle.project?.description }, { actor });
    const pid = created.id;
    for (const env of bundle.environments || []) {
      if (!['dev', 'staging', 'prod'].includes(env.name)) this.ctx.environments.create(pid, { name: env.name });
    }
    for (const col of bundle.collections || []) {
      this.db.run('INSERT OR IGNORE INTO collection_meta (id, project_id, name, options_json, created_at) VALUES (?,?,?,?,?)',
        [crypto.randomUUID(), pid, col.name, col.options_json || '{}', new Date().toISOString()]);
    }
    for (const doc of bundle.documents || []) {
      this.db.run('INSERT INTO documents (id, project_id, collection_id, data_json, created_at, updated_at, version, deleted) VALUES (?,?,?,?,?,?,1,0)',
        [crypto.randomUUID(), pid, doc.collection_id, doc.data_json, doc.created_at || new Date().toISOString(), new Date().toISOString()]);
    }
    for (const fn of bundle.functions || []) {
      this.db.run('INSERT OR IGNORE INTO functions (id, project_id, slug, name, code, timeout_ms, triggers_json, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [crypto.randomUUID(), pid, fn.slug, fn.name, fn.code, fn.timeout_ms || 10000, fn.triggers_json || '[]', 1, new Date().toISOString(), new Date().toISOString()]);
    }
    for (const wh of bundle.webhooks || []) {
      this.db.run('INSERT OR IGNORE INTO webhooks (id, project_id, name, url, secret, events_json, enabled, timeout_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [crypto.randomUUID(), pid, wh.name, wh.url, randomKey(24), wh.events_json || '[]', wh.enabled ?? 1, 10000, new Date().toISOString()]);
    }
    for (const b of bundle.buckets || []) {
      this.db.run('INSERT OR IGNORE INTO buckets (id, project_id, name, public, max_file_size, allowed_mimes, provider, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [crypto.randomUUID(), pid, b.name, b.public ?? 0, b.max_file_size || 52428800, b.allowed_mimes || '', b.provider || 'local', new Date().toISOString()]);
    }
    for (const rp of bundle.rowPolicies || []) {
      this.db.run('INSERT OR IGNORE INTO row_policies (id, project_id, table_name, policy_name, command, expression, roles, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [crypto.randomUUID(), pid, rp.table_name, rp.policy_name, rp.command || 'all', rp.expression, rp.roles || '[]', rp.enabled ?? 1, new Date().toISOString()]);
    }
    for (const sq of bundle.savedQueries || []) {
      this.db.run('INSERT INTO saved_queries (id, project_id, name, sql, created_at) VALUES (?,?,?,?,?)',
        [crypto.randomUUID(), pid, sq.name, sq.sql, new Date().toISOString()]);
    }
    this.ctx.audit?.record({ actor, action: 'project.import', target: pid, projectId: pid, meta: { from: bundle.project?.name } });
    return this.get(pid);
  }

  createApiKey(projectId, { name, type = 'custom', scopes = [{ domain: '*', actions: ['read'] }] }) {
    const prefix = { anon: 'bk_anon_', service: 'bk_service_', custom: 'bk_custom_' }[type] || 'bk_custom_';
    const key = prefix + randomKey(36);
    const id = crypto.randomUUID();
    this.db.run(
      'INSERT INTO api_keys (id, project_id, name, key_hash, key_prefix, key_type, scopes_json, revoked, created_at) VALUES (?,?,?,?,?,?,?,0,?)',
      [id, projectId, name || type + ' key', hashApiKey(key), key.slice(0, 14), type, JSON.stringify(scopes), new Date().toISOString()]
    );
    this.ctx.audit?.record({ actor: 'system', action: 'apikey.create', target: id, projectId, meta: { type, name } });
    return { id, name: name || type + ' key', type, key, scopes }; // key is shown exactly once
  }

  listApiKeys(projectId) {
    return this.db.all(
      'SELECT id, name, key_prefix, key_type, scopes_json, revoked, created_at, last_used_at FROM api_keys WHERE project_id = ? ORDER BY created_at DESC',
      [projectId]
    ).map((k) => ({ ...k, scopes_json: k.scopes_json, masked: k.key_prefix + '…' + k.key_prefix.slice(-4) }));
  }

  revokeApiKey(projectId, keyId) {
    const k = this.db.get('SELECT id FROM api_keys WHERE id = ? AND project_id = ?', [keyId, projectId]);
    if (!k) throw notFound('API key not found');
    this.db.run('UPDATE api_keys SET revoked = 1 WHERE id = ?', [keyId]);
    this.ctx.audit?.record({ actor: 'system', action: 'apikey.revoke', target: keyId, projectId });
    return { revoked: true };
  }

  usageStats(projectId, { days = 30 } = {}) {
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const requests = this.db.get('SELECT COUNT(*) AS c FROM request_logs WHERE project_id = ? AND ts >= ?', [projectId, since])?.c || 0;
    const errors = this.db.get("SELECT COUNT(*) AS c FROM request_logs WHERE project_id = ? AND ts >= ? AND status >= 400", [projectId, since])?.c || 0;
    const storageBytes = this.db.get('SELECT COALESCE(SUM(size),0) AS s FROM objects WHERE project_id = ?', [projectId])?.s || 0;
    const objectCount = this.db.get('SELECT COUNT(*) AS c FROM objects WHERE project_id = ?', [projectId])?.c || 0;
    const functionRuns = this.db.get('SELECT COUNT(*) AS c FROM function_executions WHERE project_id = ? AND created_at >= ?', [projectId, since])?.c || 0;
    const userCount = this.db.get('SELECT COUNT(*) AS c FROM users WHERE project_id = ? AND deleted_at IS NULL', [projectId])?.c || 0;
    const docCount = this.db.get('SELECT COUNT(*) AS c FROM documents WHERE project_id = ? AND deleted = 0', [projectId])?.c || 0;
    const dbSizeBytes = this.getSqliteSize(projectId);
    const byDay = this.db.all(
      "SELECT substr(ts, 1, 10) AS day, COUNT(*) AS count FROM request_logs WHERE project_id = ? AND ts >= ? GROUP BY day ORDER BY day",
      [projectId, since]
    );
    return {
      windowDays: days,
      requests, errors, errorRate: requests ? +(errors / requests * 100).toFixed(2) : 0,
      storageBytes, objectCount, functionRuns, userCount, docCount, dbSizeBytes,
      requestsByDay: byDay,
    };
  }

  getSqliteSize(projectId) {
    const conn = this.db.get('SELECT config_json FROM db_connections WHERE project_id = ? AND provider = ? AND is_default = 1', [projectId, 'sqlite']);
    if (!conn) return 0;
    try {
      const cfg = JSON.parse(conn.config_json || '{}');
      if (cfg.filename) {
        try { return fsSync.statSync(cfg.filename).size; } catch { return 0; }
      }
    } catch { }
    return 0;
  }
}
