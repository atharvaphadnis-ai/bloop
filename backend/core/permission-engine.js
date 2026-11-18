// core/permission-engine.js — role/permission matrix for dashboard users and
// scope checks for project API keys.
import { forbidden } from './error-handler.js';

export const PERMISSIONS = [
  'org.read', 'org.write', 'org.members',
  'project.read', 'project.write', 'project.delete',
  'db.read', 'db.write', 'db.admin',
  'migrations.read', 'migrations.write',
  'auth.admin', 'storage.admin', 'realtime.admin',
  'functions.read', 'functions.write', 'functions.invoke',
  'webhooks.admin', 'settings.read', 'settings.write',
  'backups.admin', 'logs.read', 'metrics.read',
  'plugins.admin', 'sdk.generate', 'import.run', 'security.admin',
];

export const ROLE_PERMISSIONS = {
  owner: ['*'],
  admin: PERMISSIONS.filter((p) => p !== 'plugins.admin' && p !== 'security.admin'),
  developer: [
    'org.read', 'project.read', 'project.write',
    'db.read', 'db.write', 'db.admin', 'migrations.read', 'migrations.write',
    'auth.admin', 'storage.admin', 'realtime.admin',
    'functions.read', 'functions.write', 'functions.invoke',
    'webhooks.admin', 'settings.read', 'backups.admin', 'logs.read', 'metrics.read',
    'sdk.generate', 'import.run',
  ],
  viewer: [
    'org.read', 'project.read', 'db.read', 'migrations.read',
    'functions.read', 'settings.read', 'logs.read', 'metrics.read',
  ],
};

export function roleCan(role, permission) {
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return false;
  return perms.includes('*') || perms.includes(permission);
}

export class PermissionEngine {
  constructor(ctx) {
    this.ctx = ctx;
  }

  can(admin, permission, { orgId = null } = {}) {
    if (!admin) return false;
    if (admin.role === 'owner') return true;
    return roleCan(admin.role, permission);
  }

  // Middleware factory — expects req.admin to be populated by the admin auth guard.
  require(permission) {
    return (req, res, next) => {
      if (!req.admin) return next(forbidden('Authentication required'));
      if (!this.can(req.admin, permission)) {
        return next(forbidden(`Your role (${req.admin.role || 'unknown'}) lacks permission "${permission}"`));
      }
      next();
    };
  }

  // API key scope check: scopes = [{ domain: 'db'|'*', actions: ['read','write','*'] }]
  static keyAllows(scopes, domain, action) {
    for (const s of scopes || []) {
      if (s.domain !== '*' && s.domain !== domain) continue;
      if (s.actions?.includes('*') || s.actions?.includes(action)) return true;
    }
    return false;
  }

  // instance-level convenience wrapper (authorization.js calls ctx.permissions.keyAllows)
  keyAllows(scopes, domain, action) {
    return PermissionEngine.keyAllows(scopes, domain, action);
  }
}
