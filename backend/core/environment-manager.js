// core/environment-manager.js — dev / staging / prod environments per project,
// environment variables (encrypted at rest, masked on read) and cloning.
import crypto from 'node:crypto';
import { badRequest, notFound, conflict } from './error-handler.js';
import { validateOrThrow } from './validation.js';

export const DEFAULT_ENVIRONMENTS = ['dev', 'staging', 'prod'];

export class EnvironmentManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'environments' });
  }

  get db() { return this.ctx.system; }

  ensureDefaultEnvironments(projectId) {
    for (const name of DEFAULT_ENVIRONMENTS) {
      const existing = this.db.get('SELECT id FROM project_environments WHERE project_id = ? AND name = ?', [projectId, name]);
      if (!existing) {
        this.db.run('INSERT INTO project_environments (id, project_id, name, is_default, created_at) VALUES (?,?,?,?,?)',
          [crypto.randomUUID(), projectId, name, name === 'dev' ? 1 : 0, new Date().toISOString()]);
      }
    }
    return this.list(projectId);
  }

  list(projectId) {
    return this.db.all(
      'SELECT id, name, is_default, cloned_from, created_at FROM project_environments WHERE project_id = ? ORDER BY created_at',
      [projectId]
    );
  }

  get(projectId, envId) {
    const env = this.db.get('SELECT * FROM project_environments WHERE id = ? AND project_id = ?', [envId, projectId]);
    if (!env) throw notFound('Environment not found');
    return env;
  }

  byName(projectId, name) {
    return this.db.get('SELECT * FROM project_environments WHERE project_id = ? AND name = ?', [projectId, name]);
  }

  create(projectId, { name, cloneOf }) {
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/i.test(name)) throw badRequest('Environment name must be 2-31 chars, letters/digits/hyphens');
    if (this.byName(projectId, name)) throw conflict(`Environment "${name}" already exists`);
    const id = crypto.randomUUID();
    this.db.run('INSERT INTO project_environments (id, project_id, name, is_default, cloned_from, created_at) VALUES (?,?,?,0,?,?)',
      [id, projectId, name, cloneOf || null, new Date().toISOString()]);
    if (cloneOf) {
      const src = this.get(projectId, cloneOf);
      for (const v of this.db.all('SELECT key, value_encrypted FROM env_vars WHERE project_id = ? AND env_id = ?', [projectId, src.id])) {
        this.db.run('INSERT INTO env_vars (id, project_id, env_id, key, value_encrypted, created_at) VALUES (?,?,?,?,?,?)',
          [crypto.randomUUID(), projectId, id, v.key, v.value_encrypted, new Date().toISOString()]);
      }
    }
    this.ctx.audit?.record({ actor: 'system', action: 'environment.create', projectId, target: id, meta: { name, cloneOf: cloneOf || null } });
    return this.get(projectId, id);
  }

  clone(projectId, envId, { name }) {
    return this.create(projectId, { name, cloneOf: envId });
  }

  setDefault(projectId, envId) {
    this.get(projectId, envId);
    this.db.run('UPDATE project_environments SET is_default = 0 WHERE project_id = ?', [projectId]);
    this.db.run('UPDATE project_environments SET is_default = 1 WHERE id = ?', [envId]);
    return this.get(projectId, envId);
  }

  delete(projectId, envId) {
    const env = this.get(projectId, envId);
    if (DEFAULT_ENVIRONMENTS.includes(env.name)) throw badRequest(`Cannot delete the built-in "${env.name}" environment`);
    const connCount = this.db.get('SELECT COUNT(*) AS c FROM db_connections WHERE env_id = ?', [envId])?.c || 0;
    if (connCount > 0) throw conflict('Environment has database connections; remove them first');
    this.db.run('DELETE FROM project_environments WHERE id = ?', [envId]);
    this.db.run('DELETE FROM env_vars WHERE env_id = ?', [envId]);
    return { deleted: true };
  }

  // ── Environment variables ────────────────────────────────────────────────
  setVar(projectId, envId, key, value) {
    this.get(projectId, envId);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) throw badRequest('Variable name must match [A-Za-z_][A-Za-z0-9_]*');
    const enc = this.ctx.security.encrypt(String(value));
    const existing = this.db.get('SELECT id FROM env_vars WHERE project_id = ? AND env_id = ? AND key = ?', [projectId, envId, key]);
    if (existing) {
      this.db.run('UPDATE env_vars SET value_encrypted = ?, updated_at = ? WHERE id = ?', [enc, new Date().toISOString(), existing.id]);
    } else {
      this.db.run('INSERT INTO env_vars (id, project_id, env_id, key, value_encrypted, created_at) VALUES (?,?,?,?,?,?)',
        [crypto.randomUUID(), projectId, envId, key, enc, new Date().toISOString()]);
    }
    this.ctx.audit?.record({ actor: 'system', action: 'envvar.set', projectId, target: key, meta: { envId } });
    return { key, envId };
  }

  // Values are NEVER returned through the admin API — this is internal use only
  // (function execution, etc).
  getVar(projectId, envId, key) {
    const row = this.db.get('SELECT value_encrypted FROM env_vars WHERE project_id = ? AND env_id = ? AND key = ?', [projectId, envId, key]);
    return row ? this.ctx.security.decrypt(row.value_encrypted) : undefined;
  }

  listVars(projectId, envId) {
    return this.db.all('SELECT id, key, created_at, updated_at FROM env_vars WHERE project_id = ? AND env_id = ? ORDER BY key', [projectId, envId])
      .map((v) => ({ ...v, value: '••••••••' }));
  }

  deleteVar(projectId, envId, key) {
    const row = this.db.get('SELECT id FROM env_vars WHERE project_id = ? AND env_id = ? AND key = ?', [projectId, envId, key]);
    if (!row) throw notFound('Variable not found');
    this.db.run('DELETE FROM env_vars WHERE id = ?', [row.id]);
    return { deleted: true };
  }

  resolveVars(projectId, envId) {
    const rows = this.db.all('SELECT key, value_encrypted FROM env_vars WHERE project_id = ? AND env_id = ?', [projectId, envId]);
    const out = {};
    for (const r of rows) {
      try { out[r.key] = this.ctx.security.decrypt(r.value_encrypted); } catch { out[r.key] = ''; }
    }
    return out;
  }
}
