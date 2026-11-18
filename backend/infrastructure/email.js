// infrastructure/email.js — SMTP client built directly on node:net/node:tls
// (no dependencies): EHLO, STARTTLS, AUTH PLAIN/LOGIN, message delivery with
// MIME multipart bodies, per-project sender identities, editable HTML
// templates, delivery logging and a test-send function.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { badRequest, notFound } from '../core/error-handler.js';
import { validateOrThrow } from '../core/validation.js';

export class EmailService {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'email' });
  }

  get db() { return this.ctx.system; }

  // ── Settings ──────────────────────────────────────────────────────────────
  getSettings(projectId = null) {
    const row = projectId
      ? this.db.get('SELECT * FROM smtp_settings WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1', [projectId])
      : this.db.get('SELECT * FROM smtp_settings WHERE project_id IS NULL ORDER BY updated_at DESC LIMIT 1');
    if (!row) return null;
    return {
      ...row,
      password: '••••••••',
      enabled: !!row.enabled,
    };
  }

  async saveSettings(projectId, input) {
    const data = validateOrThrow({
      host: { type: 'string', required: true, max: 200 },
      port: { type: 'integer', required: true, min: 1, max: 65535 },
      secure: { type: 'boolean', default: false },
      username: { type: 'string', max: 200 },
      password: { type: 'string', max: 200 },
      fromEmail: { type: 'string', required: true, max: 200 },
      fromName: { type: 'string', max: 100 },
      enabled: { type: 'boolean', default: true },
    }, input);
    const existing = this.db.get('SELECT * FROM smtp_settings WHERE project_id = ?', [projectId]);
    const now = new Date().toISOString();
    const passwordEnc = data.password ? this.ctx.security.encrypt(data.password) : existing?.password_encrypted || null;
    if (existing) {
      this.db.run(
        'UPDATE smtp_settings SET host = ?, port = ?, secure = ?, username = ?, password_encrypted = ?, from_email = ?, from_name = ?, enabled = ?, updated_at = ? WHERE id = ?',
        [data.host, data.port, data.secure ? 1 : 0, data.username || null, passwordEnc, data.fromEmail, data.fromName || '', data.enabled ? 1 : 0, now, existing.id]
      );
    } else {
      this.db.run(
        'INSERT INTO smtp_settings (id, project_id, host, port, secure, username, password_encrypted, from_email, from_name, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [crypto.randomUUID(), projectId, data.host, data.port, data.secure ? 1 : 0, data.username || null, passwordEnc, data.fromEmail, data.fromName || '', data.enabled ? 1 : 0, now, now]
      );
    }
    const s = this.getSettings(projectId);
    return s;
  }

  _rawSettings(projectId) {
    const row = this.db.get('SELECT * FROM smtp_settings WHERE project_id = ? AND enabled = 1 ORDER BY updated_at DESC LIMIT 1', [projectId]);
    if (!row) return null;
    let password = null;
    if (row.password_encrypted) {
      try { password = this.ctx.security.decrypt(row.password_encrypted); } catch { password = null; }
    }
    return { ...row, password };
  }

  // ── SMTP protocol ─────────────────────────────────────────────────────────
  async _smtpDialogue(settings, message) {
    const { host, port, secure, username, password } = settings;
    let socket = await (secure ? this._tlsConnect(host, port) : this._tcpConnect(host, port));
    const state = { socket, buffer: '', capabilities: '' };
    const readReply = () => this._readReply(state);
    try {
      const greeting = await readReply();
      if (greeting.code >= 400) throw new Error(`SMTP greeting failed: ${greeting.text}`);

      await this._command(state, `EHLO bloop.local`, (r) => { state.capabilities = r.raw; });

      // STARTTLS when not already implicit-TLS and the server offers it
      if (!secure && /STARTTLS/i.test(state.capabilities)) {
        await this._command(state, 'STARTTLS');
        socket = await new Promise((resolve, reject) => {
          const tlsSocket = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => resolve(tlsSocket));
          tlsSocket.on('error', reject);
        });
        state.socket = socket;
        state.buffer = '';
        await this._command(state, 'EHLO bloop.local', (r) => { state.capabilities = r.raw; });
      }

      if (username && password) {
        if (/AUTH/i.test(state.capabilities)) {
          if (/AUTH[^\n]*PLAIN/i.test(state.capabilities)) {
            const encoded = Buffer.from(`\u0000${username}\u0000${password}`).toString('base64');
            await this._command(state, `AUTH PLAIN ${encoded}`);
          } else if (/AUTH[^\n]*LOGIN/i.test(state.capabilities)) {
            await this._command(state, 'AUTH LOGIN');
            await this._command(state, Buffer.from(username).toString('base64'));
            await this._command(state, Buffer.from(password).toString('base64'));
          } else {
            throw new Error('SMTP server supports no compatible AUTH mechanism (need PLAIN or LOGIN)');
          }
        }
      }

      await this._command(state, `MAIL FROM:<${settings.from_email}>`);
      for (const rcpt of message.to) {
        await this._command(state, `RCPT TO:<${rcpt}>`);
      }
      await this._command(state, 'DATA');
      // dot-stuffing per RFC 5321
      const data = message.raw.replace(/\r?\n\./g, '\n..');
      await this._command(state, data + '\r\n.', (r) => r);
      await this._command(state, 'QUIT');
      return { delivered: true };
    } finally {
      try { socket.destroy(); } catch { }
    }
  }

  _tcpConnect(host, port) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port }, () => resolve(socket));
      socket.setTimeout(15_000, () => { socket.destroy(); reject(new Error(`SMTP connection to ${host}:${port} timed out`)); });
      socket.on('error', (err) => reject(new Error(`SMTP connect failed: ${err.message}`)));
    });
  }

  _tlsConnect(host, port) {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => resolve(socket));
      socket.setTimeout(15_000, () => { socket.destroy(); reject(new Error(`SMTP TLS connection to ${host}:${port} timed out`)); });
      socket.on('error', (err) => reject(new Error(`SMTP TLS connect failed: ${err.message}`)));
    });
  }

  _readReply(state) {
    return new Promise((resolve, reject) => {
      if (!state.attached) {
        state.attached = true;
        state.socket.on('data', (chunk) => { state.buffer += chunk.toString('utf8'); });
        state.socket.on('error', (err) => { state.error = err; });
      }
      const start = Date.now();
      const poll = () => {
        if (state.error) return reject(new Error(`SMTP connection error: ${state.error.message}`));
        const lines = state.buffer.split('\r\n');
        let consumed = 0;
        const raw = [];
        let code = null;
        for (const line of lines) {
          if (!/^\d{3}[ -]/.test(line)) break;
          raw.push(line);
          consumed += line.length + 2;
          code = parseInt(line.slice(0, 3), 10);
          if (line[3] === ' ') {
            state.buffer = state.buffer.slice(consumed);
            return resolve({ code, text: line.slice(4), raw: raw.join('\n') });
          }
        }
        if (Date.now() - start > 30_000) return reject(new Error('SMTP reply timeout'));
        setTimeout(poll, 20);
      };
      poll();
    });
  }

  async _command(state, cmd, transform = null) {
    await new Promise((resolve, reject) => {
      state.socket.write(cmd + '\r\n', (err) => (err ? reject(err) : resolve()));
    });
    const reply = await this._readReply(state);
    if (reply.code >= 500 || (reply.code >= 400 && !cmd.startsWith('DATA'))) {
      throw new Error(`SMTP command "${cmd.split('\r\n')[0].slice(0, 40)}…" failed with ${reply.code}: ${reply.text}`);
    }
    return transform ? transform(reply) : reply;
  }

  // ── Message building ──────────────────────────────────────────────────────
  buildMessage({ fromEmail, fromName, to, subject, text, html }) {
    const boundary = `bloop_${crypto.randomBytes(12).toString('hex')}`;
    const headers = [
      `From: ${fromName ? `${fromName} <${fromEmail}>` : fromEmail}`,
      `To: ${to.join(', ')}`,
      `Subject: ${String(subject).replace(/[\r\n]/g, ' ')}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomBytes(10).toString('hex')}@bloop.local>`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ];
    const body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      text || 'This message has no plain-text version.',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      html || `<p>${text || ''}</p>`,
      `--${boundary}--`,
    ].join('\r\n');
    return { to, raw: headers.join('\r\n') + '\r\n\r\n' + body };
  }

  // ── High-level send ───────────────────────────────────────────────────────
  async send(projectId, { to, subject, text, html, template = null }) {
    const recipients = Array.isArray(to) ? to : [to];
    for (const r of recipients) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r)) throw badRequest(`Invalid recipient address: ${r}`);
    const settings = this._rawSettings(projectId);
    if (!settings) {
      await this._logDelivery(projectId, recipients[0], subject, template, 'skipped', 'SMTP is not configured for this project');
      return { sent: false, reason: 'smtp_not_configured' };
    }
    const message = this.buildMessage({
      fromEmail: settings.from_email, fromName: settings.from_name,
      to: recipients, subject, text, html,
    });
    try {
      await this._smtpDialogue(settings, message);
      await this._logDelivery(projectId, recipients[0], subject, template, 'sent', null);
      this.log.info(`email sent to ${recipients[0]} (${subject})`);
      return { sent: true };
    } catch (err) {
      await this._logDelivery(projectId, recipients[0], subject, template, 'failed', err.message);
      this.log.warn(`email delivery failed: ${err.message}`);
      return { sent: false, reason: 'delivery_failed', error: err.message };
    }
  }

  async _logDelivery(projectId, to, subject, template, status, error) {
    try {
      this.db.run('INSERT INTO email_log (project_id, "to", subject, template, status, error, created_at) VALUES (?,?,?,?,?,?,?)',
        [projectId, to, String(subject).slice(0, 200), template, status, error, new Date().toISOString()]);
    } catch { /* never break on logging */ }
  }

  // ── Templates ─────────────────────────────────────────────────────────────
  DEFAULT_TEMPLATES = {
    verify_email: {
      subject: 'Verify your email',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
<h2>Verify your email</h2>
<p>Welcome to {{app}}! Confirm your email address to activate your account:</p>
<p><a href="{{link}}" style="display:inline-block;background:#3bf95c;color:#06130a;padding:10px 22px;border-radius:8px;font-weight:700;text-decoration:none">Verify email</a></p>
<p>Or use this token: <code>{{token}}</code></p>
<p>If you did not create this account you can ignore this email.</p></div>`,
    },
    password_reset: {
      subject: 'Reset your password',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
<h2>Password reset</h2>
<p>We received a request to reset your password. This link expires in 1 hour:</p>
<p><a href="{{link}}" style="display:inline-block;background:#3bf95c;color:#06130a;padding:10px 22px;border-radius:8px;font-weight:700;text-decoration:none">Reset password</a></p>
<p>Or use this token: <code>{{token}}</code></p>
<p>If you did not request this, no action is needed.</p></div>`,
    },
    invitation: {
      subject: 'You have been invited to an organization',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
<h2>Organization invitation</h2>
<p>You have been invited to join <b>{{org}}</b> on {{app}} with the role <b>{{role}}</b>.</p>
<p>Sign in to your dashboard and accept the invitation with this token:</p>
<p><code>{{token}}</code></p></div>`,
    },
  };

  ensureDefaultTemplates(projectId) {
    for (const [name, tpl] of Object.entries(this.DEFAULT_TEMPLATES)) {
      const existing = this.db.get('SELECT id FROM email_templates WHERE project_id = ? AND template = ?', [projectId, name]);
      if (!existing) {
        this.db.run('INSERT INTO email_templates (id, project_id, template, subject, html, updated_at) VALUES (?,?,?,?,?,?)',
          [crypto.randomUUID(), projectId, name, tpl.subject, tpl.html, new Date().toISOString()]);
      }
    }
  }

  listTemplates(projectId) {
    this.ensureDefaultTemplates(projectId);
    return this.db.all('SELECT id, template, subject, updated_at FROM email_templates WHERE project_id = ? ORDER BY template', [projectId]);
  }

  getTemplate(projectId, name) {
    const row = this.db.get('SELECT * FROM email_templates WHERE project_id = ? AND template = ?', [projectId, name]);
    if (!row) throw notFound(`Template "${name}" not found`);
    return row;
  }

  saveTemplate(projectId, name, { subject, html }) {
    if (!this.DEFAULT_TEMPLATES[name]) throw badRequest(`Unknown template "${name}" (known: ${Object.keys(this.DEFAULT_TEMPLATES).join(', ')})`);
    this.ensureDefaultTemplates(projectId);
    this.db.run('UPDATE email_templates SET subject = ?, html = ?, updated_at = ? WHERE project_id = ? AND template = ?',
      [subject, html, new Date().toISOString(), projectId, name]);
    return this.getTemplate(projectId, name);
  }

  render(html, vars) {
    return String(html).replace(/\{\{(\w+)\}\}/g, (m, key) => vars[key] !== undefined ? String(vars[key]) : '');
  }

  // ── Named flows ───────────────────────────────────────────────────────────
  async sendVerification(projectId, to, token) {
    const tpl = this.getTemplate(projectId, 'verify_email');
    const app = this.ctx.security.settingsGet('platform', 'name', 'Bloop');
    const base = this.ctx.config.get('server.publicOrigin') || `http://localhost:${this.ctx.config.get('server.port')}`;
    return this.send(projectId, {
      to, template: 'verify_email', subject: this.render(tpl.subject, { app }),
      html: this.render(tpl.html, { app, token, link: `${base}/#/verify-email?token=${token}` }),
      text: `Verify your email: ${base}/#/verify-email?token=${token}`,
    });
  }

  async sendPasswordReset(projectId, to, token) {
    const tpl = this.getTemplate(projectId, 'password_reset');
    const app = this.ctx.security.settingsGet('platform', 'name', 'Bloop');
    const base = this.ctx.config.get('server.publicOrigin') || `http://localhost:${this.ctx.config.get('server.port')}`;
    return this.send(projectId, {
      to, template: 'password_reset', subject: this.render(tpl.subject, { app }),
      html: this.render(tpl.html, { app, token, link: `${base}/#/reset-password?token=${token}` }),
      text: `Reset your password: ${base}/#/reset-password?token=${token}`,
    });
  }

  async sendInvitation({ to, orgId, role, token }) {
    const org = this.db.get('SELECT name FROM organizations WHERE id = ?', [orgId]);
    const projectId = null; // invitations are platform-level
    const tpl = { subject: 'You have been invited to an organization', html: this.DEFAULT_TEMPLATES.invitation.html };
    const app = this.ctx.security.settingsGet('platform', 'name', 'Bloop');
    return this.send(projectId, {
      to, template: 'invitation', subject: tpl.subject,
      html: this.render(tpl.html, { app, org: org?.name || 'an organization', role, token }),
      text: `You were invited to ${org?.name || 'an organization'} with the role ${role}. Token: ${token}`,
    });
  }

  async testSend(projectId, to) {
    return this.send(projectId, {
      to, template: 'test', subject: 'Bloop test email',
      text: 'This is a test email from your Bloop instance. If you can read this, SMTP is working.',
      html: '<p>This is a <b>test email</b> from your Bloop instance. If you can read this, SMTP is working. 🎉</p>'.replace('🎉', ''),
    });
  }

  deliveryLog(projectId, { limit = 100 } = {}) {
    return this.db.all('SELECT * FROM email_log WHERE project_id = ? OR ? IS NULL ORDER BY id DESC LIMIT ?', [projectId, projectId, limit]);
  }
}

export async function register(ctx) {
  ctx.email = new EmailService(ctx);
}
