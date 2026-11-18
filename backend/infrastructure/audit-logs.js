// infrastructure/audit-logs.js — immutable audit trail of administrative and
// security-relevant actions, with search, filters and CSV export.
import { badRequest } from '../core/error-handler.js';

export class AuditLogService {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'audit' });
  }

  get db() { return this.ctx.system; }

  record({ actor = 'system', actorType = 'admin', action, target = null, projectId = null, orgId = null, meta = null, ip = null }) {
    try {
      this.db.run(
        'INSERT INTO audit_logs (org_id, project_id, actor, actor_type, action, target, metadata_json, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [orgId, projectId, String(actor), actorType, String(action), target ? String(target) : null,
          meta ? JSON.stringify(this.ctx.security.redact(meta)) : null, ip, new Date().toISOString()]
      );
    } catch (err) {
      this.log.debug(`audit write failed: ${err.message}`);
    }
  }

  list({ projectId = null, orgId = null, actor = null, action = null, since = null, limit = 200, offset = 0 } = {}) {
    const clauses = [];
    const params = [];
    if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
    if (orgId) { clauses.push('org_id = ?'); params.push(orgId); }
    if (actor) { clauses.push('actor = ?'); params.push(actor); }
    if (action) { clauses.push('action = ?'); params.push(action); }
    if (since) { clauses.push('created_at >= ?'); params.push(since); }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = this.db.all(`SELECT * FROM audit_logs${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, Math.min(limit, 1000), Math.max(offset, 0)]);
    const total = this.db.get(`SELECT COUNT(*) AS c FROM audit_logs${where}`, params)?.c || 0;
    return { entries: rows.map((r) => ({ ...r, metadata: r.metadata_json ? JSON.parse(r.metadata_json) : null })), total };
  }

  exportCsv(entries) {
    const cols = ['id', 'created_at', 'actor', 'actor_type', 'action', 'target', 'project_id', 'ip'];
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [cols.join(','), ...entries.map((e) => cols.map((c) => esc(e[c])).join(','))].join('\n');
  }

  // actions emitted on the bus for external audit sinks (plugins)
  wireBusEvents() {
    const interesting = ['project.created', 'project.deleted', 'auth.login', 'auth.login_failed', 'backup.verified', 'restore.completed', 'plugin.loaded'];
    for (const evt of interesting) {
      this.ctx.bus.on(evt, (payload) => {
        this.record({
          actor: 'system',
          actorType: 'event',
          action: evt,
          target: payload?.projectId || payload?.userId || null,
          projectId: payload?.projectId || null,
          meta: payload,
        });
      });
    }
  }

  prune(days = 180) {
    this.db.run('DELETE FROM audit_logs WHERE created_at < ?', [new Date(Date.now() - days * 86400_000).toISOString()]);
  }
}

export async function register(ctx) {
  ctx.audit = new AuditLogService(ctx);
  ctx.audit.wireBusEvents();
}
