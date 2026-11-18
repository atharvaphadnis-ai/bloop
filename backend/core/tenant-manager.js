// core/tenant-manager.js — organizations, members, invitations and roles.
import crypto from 'node:crypto';
import { badRequest, notFound, conflict, forbidden } from './error-handler.js';
import { validateOrThrow } from './validation.js';

export const ORG_ROLES = ['owner', 'admin', 'developer', 'viewer'];

export class TenantManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'tenants' });
  }

  get db() { return this.ctx.system; }

  async ensureDefaultOrganization(name = 'My Organization') {
    const existing = this.db.get('SELECT id FROM organizations ORDER BY created_at LIMIT 1');
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    this.db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)',
      [id, name, slugify(name), new Date().toISOString()]);
    return id;
  }

  createOrg(input) {
    const data = validateOrThrow({
      name: { type: 'string', required: true, min: 2, max: 64 },
    }, input);
    const id = crypto.randomUUID();
    let slug = slugify(data.name);
    if (this.db.get('SELECT id FROM organizations WHERE slug = ?', [slug])) {
      slug = `${slug}-${id.slice(0, 6)}`;
    }
    this.db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)',
      [id, data.name, slug, new Date().toISOString()]);
    this.ctx.audit?.record({ actor: 'system', action: 'org.create', target: id, meta: { name: data.name } });
    return this.getOrg(id);
  }

  listOrgs() {
    return this.db.all('SELECT * FROM organizations ORDER BY created_at');
  }

  getOrg(id) {
    const org = this.db.get('SELECT * FROM organizations WHERE id = ?', [id]);
    if (!org) throw notFound('Organization not found');
    org.members = this.listMembers(id);
    org.projects_count = this.db.get('SELECT COUNT(*) AS c FROM projects WHERE org_id = ?', [id])?.c || 0;
    return org;
  }

  updateOrg(id, patch) {
    this.getOrg(id);
    const data = validateOrThrow({ name: { type: 'string', min: 2, max: 64 } }, patch);
    if (data.name) this.db.run('UPDATE organizations SET name = ? WHERE id = ?', [data.name, id]);
    return this.getOrg(id);
  }

  deleteOrg(id) {
    const org = this.getOrg(id);
    const projects = this.db.get('SELECT COUNT(*) AS c FROM projects WHERE org_id = ?', [id])?.c || 0;
    if (projects > 0) throw conflict('Organization still has projects. Delete them first.');
    const owners = this.db.get("SELECT COUNT(*) AS c FROM org_members WHERE org_id = ? AND role = 'owner'", [id])?.c || 0;
    this.db.run('DELETE FROM organizations WHERE id = ?', [id]);
    this.db.run('DELETE FROM org_members WHERE org_id = ?', [id]);
    return { deleted: true, name: org.name };
  }

  listMembers(orgId) {
    return this.db.all(
      `SELECT om.user_id, om.role, om.created_at, au.email, au.name
       FROM org_members om JOIN admin_users au ON au.id = om.user_id
       WHERE om.org_id = ? ORDER BY om.created_at`,
      [orgId]
    );
  }

  addMember(orgId, { email, role }) {
    if (!ORG_ROLES.includes(role)) throw badRequest(`role must be one of: ${ORG_ROLES.join(', ')}`);
    const user = this.db.get('SELECT id FROM admin_users WHERE email = ?', [String(email).toLowerCase()]);
    if (!user) throw notFound('No dashboard user with that email. Send an invitation instead.');
    const existing = this.db.get('SELECT user_id FROM org_members WHERE org_id = ? AND user_id = ?', [orgId, user.id]);
    if (existing) throw conflict('User is already a member');
    this.db.run('INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?,?,?,?)',
      [orgId, user.id, role, new Date().toISOString()]);
    this.ctx.audit?.record({ actor: 'system', action: 'org.member.add', target: user.id, meta: { org: orgId, role } });
    return { user_id: user.id, role };
  }

  updateMember(orgId, userId, { role }) {
    if (!ORG_ROLES.includes(role)) throw badRequest(`role must be one of: ${ORG_ROLES.join(', ')}`);
    const m = this.db.get('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?', [orgId, userId]);
    if (!m) throw notFound('Member not found');
    if (m.role === 'owner' && role !== 'owner') {
      const owners = this.db.get("SELECT COUNT(*) AS c FROM org_members WHERE org_id = ? AND role = 'owner'", [orgId])?.c || 0;
      if (owners <= 1) throw badRequest('Organization must keep at least one owner');
    }
    this.db.run('UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?', [role, orgId, userId]);
    return { user_id: userId, role };
  }

  removeMember(orgId, userId) {
    const m = this.db.get('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?', [orgId, userId]);
    if (!m) throw notFound('Member not found');
    if (m.role === 'owner') {
      const owners = this.db.get("SELECT COUNT(*) AS c FROM org_members WHERE org_id = ? AND role = 'owner'", [orgId])?.c || 0;
      if (owners <= 1) throw badRequest('Cannot remove the last owner');
    }
    this.db.run('DELETE FROM org_members WHERE org_id = ? AND user_id = ?', [orgId, userId]);
    return { removed: true };
  }

  createInvitation(orgId, { email, role }, { invitedBy = 'system', sendEmail = true } = {}) {
    if (!ORG_ROLES.includes(role)) throw badRequest(`role must be one of: ${ORG_ROLES.join(', ')}`);
    const token = crypto.randomBytes(24).toString('base64url');
    const id = crypto.randomUUID();
    const expires = new Date(Date.now() + 7 * 86400_000).toISOString();
    this.db.run(
      'INSERT INTO invitations (id, org_id, email, role, token_hash, status, invited_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, orgId, String(email).toLowerCase(), role, hashToken(token), 'pending', invitedBy, new Date().toISOString(), expires]
    );
    this.ctx.audit?.record({ actor: invitedBy, action: 'org.invite', target: id, meta: { email, role, org: orgId } });
    let emailResult = null;
    if (sendEmail) {
      emailResult = this.ctx.email?.sendInvitation?.({ to: String(email).toLowerCase(), orgId, role, token }) || null;
    }
    // token returned only at creation time
    return { id, email, role, token, expiresAt: expires, emailed: !!emailResult?.sent };
  }

  listInvitations(orgId) {
    return this.db.all('SELECT id, email, role, status, invited_by, created_at, expires_at FROM invitations WHERE org_id = ? ORDER BY created_at DESC', [orgId]);
  }

  revokeInvitation(orgId, inviteId) {
    const inv = this.db.get('SELECT * FROM invitations WHERE id = ? AND org_id = ?', [inviteId, orgId]);
    if (!inv) throw notFound('Invitation not found');
    this.db.run("UPDATE invitations SET status = 'revoked' WHERE id = ?", [inviteId]);
    return { revoked: true };
  }

  // Accept an invitation token — the accepting user must already be signed in.
  acceptInvitation(token, userId) {
    const hash = hashToken(token);
    const inv = this.db.get("SELECT * FROM invitations WHERE token_hash = ? AND status = 'pending'", [hash]);
    if (!inv) throw notFound('Invitation not found or already used');
    if (inv.expires_at < new Date().toISOString()) {
      this.db.run("UPDATE invitations SET status = 'expired' WHERE id = ?", [inv.id]);
      throw badRequest('Invitation has expired');
    }
    const existing = this.db.get('SELECT user_id FROM org_members WHERE org_id = ? AND user_id = ?', [inv.org_id, userId]);
    if (!existing) {
      this.db.run('INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?,?,?,?)',
        [inv.org_id, userId, inv.role, new Date().toISOString()]);
    }
    this.db.run("UPDATE invitations SET status = 'accepted' WHERE id = ?", [inv.id]);
    return { orgId: inv.org_id, role: inv.role };
  }

  orgsForUser(userId) {
    return this.db.all(
      `SELECT o.*, om.role FROM organizations o JOIN org_members om ON om.org_id = o.id
       WHERE om.user_id = ? ORDER BY o.created_at`,
      [userId]
    );
  }

  requireMembership(userId, orgId) {
    const m = this.db.get('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?', [orgId, userId]);
    if (!m) throw forbidden('You are not a member of this organization');
    return m.role;
  }
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'org';
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
