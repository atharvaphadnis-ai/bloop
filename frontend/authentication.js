// authentication.js — two pages: Authentication (SMTP, email templates, OAuth
// providers, JWT/security settings) and Users (end-user management for the
// selected project).
import {
  h, clear, get, post, patch, del, put, icon, state, toast, toastSuccess,
  toastError, modal, field, formRow, emptyState, requireProject, badge,
  fmtDate, dataTable, confirmDialog, safeParse, fmtNumber, copyChip,
} from './components.js';
import { register } from './router.js';

/* ═══ Authentication settings page ═══════════════════════════════════════ */
register('authentication', {
  title: 'Authentication',
  async render(page) {
    if (!requireProject(page, 'Authentication')) return;
    const settings = await get(`/api/admin/projects/${state.projectId}/auth/settings`);
    const smtp = (await get(`/api/admin/projects/${state.projectId}/smtp`)).settings;

    const securityCard = h('div', { class: 'card' },
      h('div', { class: 'card-header' },
        h('div', {}, h('div', { class: 'card-title' }, 'Security settings'),
          h('div', { class: 'card-sub' }, 'Password hashing: scrypt (memory-hard) · Access tokens: JWT HS256, 15 min · Refresh tokens rotate on use')),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: () => go('#/api') }, 'API keys →')),
      h('label', { class: 'checkbox-row' },
        Object.assign(h('input', { type: 'checkbox' }), { checked: settings.requireEmailVerification }),
        'Require email verification before login'),
      h('button', { class: 'btn btn-secondary btn-sm', style: { marginTop: '10px' }, onclick: async (e) => {
        const enabled = e.target.previousElementSibling.firstChild.checked;
        try { await put(`/api/admin/projects/${state.projectId}/auth/settings`, { requireEmailVerification: enabled }); toastSuccess('Saved'); }
        catch (err) { toastError(err); }
      } }, 'Save'));

    const smtpCard = h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-header' },
        h('div', {}, h('div', { class: 'card-title' }, 'SMTP & email'),
          h('div', { class: 'card-sub' }, smtp ? `${smtp.host}:${smtp.port} · from ${smtp.fromEmail}` : 'Not configured — verification/reset tokens are returned in API responses (dev mode)')),
        h('div', { style: { display: 'flex', gap: '6px' } },
          h('button', { class: 'btn btn-ghost btn-sm', onclick: () => showTestEmailModal() }, icon('mail'), 'Send test'),
          h('button', { class: 'btn btn-secondary btn-sm', onclick: () => showSmtpModal(smtpCardRender) }, icon('edit'), 'Configure'))),
      h('div', { id: 'smtp-summary' },
        smtp ? h('div', { class: 'kv-list' },
          h('dt', {}, 'Host'), h('dd', {}, `${smtp.host}:${smtp.port} ${smtp.secure ? '(implicit TLS)' : '(STARTTLS when offered)'}`),
          h('dt', {}, 'Sender'), h('dd', {}, `${smtp.fromName || ''} <${smtp.fromEmail}>`),
          h('dt', {}, 'Enabled'), h('dd', {}, smtp.enabled ? 'yes' : 'no')) : null,
        smtp ? h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn btn-ghost btn-sm', onclick: () => showEmailLogModal() }, icon('list'), 'Delivery log')) : null));

    function smtpCardRender() {
      location.reload();
    }

    const oauthRows = (settings.oauthProviders || []);
    const oauthCard = h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-header' },
        h('div', {}, h('div', { class: 'card-title' }, 'OAuth providers'),
          h('div', { class: 'card-sub' }, 'Client secrets are encrypted at rest and never returned by the API')),
        h('button', { class: 'btn btn-primary btn-sm', onclick: () => showOAuthModal(() => location.reload()) }, icon('plus'), 'Add provider')),
      oauthRows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Provider'), h('th', {}, 'Client ID'), h('th', {}, 'Redirect URL'), h('th', {}, 'Status'), h('th', {}, ''))),
        h('tbody', {}, ...oauthRows.map((c) => h('tr', {},
          h('td', { class: 'cell-mono' }, c.provider),
          h('td', { class: 'cell-dim mono' }, c.client_id?.slice(0, 24)),
          h('td', { class: 'cell-dim mono' }, c.redirect_url || '—'),
          h('td', {}, badge(c.enabled ? 'ENABLED' : 'DISABLED', c.enabled ? 'green' : 'gray')),
          h('td', {}, h('div', { class: 'row-actions' },
            h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
              const r = await post(`/api/admin/projects/${state.projectId}/oauth/${c.provider}/test`);
              r.ok ? toastSuccess(`Provider endpoint reachable (${r.status})`) : toastError(r.error);
            } }, 'Test'),
            h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
              await del(`/api/admin/projects/${state.projectId}/oauth/${c.provider}`);
              toastSuccess('Provider removed'); location.reload();
            } }, icon('trash'))))))))) : h('div', { class: 'cell-dim', style: { padding: '10px' } }, 'No OAuth providers configured'),
      h('div', { class: 'callout', style: { marginTop: '10px' } },
        'Supported: Google, GitHub, Discord (built-in) — start URL: ',
        h('span', { class: 'mono' }, `/api/v1/${state.projectId}/auth/oauth/google/start`)));

    const templatesCard = h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-header' }, h('div', {}, h('div', { class: 'card-title' }, 'Email templates'),
        h('div', { class: 'card-sub' }, 'Variables: {{app}}, {{token}}, {{link}}, {{org}}, {{role}}')),
      ),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        ...['verify_email', 'password_reset', 'invitation'].map((name) =>
          h('button', { class: 'btn btn-ghost btn-sm', onclick: () => showTemplateModal(name) }, name))));

    page.append(
      h('div', { class: 'page-header' },
        h('div', {},
          h('h2', { class: 'page-title' }, 'Authentication'),
          h('p', { class: 'page-subtitle' }, 'Email/password + email verification + password reset + TOTP MFA + passkeys (WebAuthn) + OAuth linking, per project.')),
        h('div', { class: 'page-actions' },
          h('button', { class: 'btn btn-secondary', onclick: () => location.hash = '#/users' }, icon('users'), 'Manage users'))),
      securityCard, smtpCard, oauthCard, templatesCard);

    function showTestEmailModal() {
      const to = h('input', { class: 'input', type: 'email', placeholder: 'you@example.com' });
      const m = modal({
        title: 'Send test email',
        body: field('To', to),
        footer: h('button', { class: 'btn btn-primary', onclick: async () => {
          try {
            const r = await post(`/api/admin/projects/${state.projectId}/smtp/test`, { to: to.value });
            r.sent ? toastSuccess('Test email sent via SMTP') : toast(`${r.reason}: ${r.error || 'check SMTP settings'}`, { type: 'warn' });
            m.close();
          } catch (e) { toastError(e); }
        } }, 'Send'),
      });
    }

    function showSmtpModal(reload) {
      const host = h('input', { class: 'input mono', value: smtp?.host || '', placeholder: 'smtp.example.com' });
      const port = h('input', { class: 'input mono', type: 'number', value: smtp?.port || 587 });
      const secure = h('input', { type: 'checkbox' });
      secure.checked = !!smtp?.secure;
      const user = h('input', { class: 'input mono', value: smtp?.username || '' });
      const pass = h('input', { class: 'input mono', type: 'password', placeholder: smtp ? '•••••••• (unchanged)' : 'password' });
      const fromEmail = h('input', { class: 'input mono', value: smtp?.fromEmail || '', placeholder: 'no-reply@example.com' });
      const fromName = h('input', { class: 'input', value: smtp?.fromName || '' });
      const enabled = h('input', { type: 'checkbox' });
      enabled.checked = smtp ? !!smtp.enabled : true;
      const m = modal({
        title: 'SMTP settings',
        size: 'modal-lg',
        body: h('div', {},
          formRow(field('Host', host), formRow(field('Port', port), field('', h('label', { class: 'checkbox-row', style: { marginTop: '20px' } }, secure, 'Implicit TLS (port 465)')))),
          formRow(field('Username', user), field('Password', pass, { hint: 'Stored encrypted' })),
          formRow(field('From email', fromEmail), field('From name', fromName)),
          h('label', { class: 'checkbox-row' }, enabled, 'Enabled')),
        footer: h('button', { class: 'btn btn-primary', onclick: async () => {
          try {
            await put(`/api/admin/projects/${state.projectId}/smtp`, {
              host: host.value, port: Number(port.value), secure: secure.checked,
              username: user.value, password: pass.value || undefined,
              fromEmail: fromEmail.value, fromName: fromName.value, enabled: enabled.checked,
            });
            toastSuccess('SMTP saved'); m.close(); reload();
          } catch (e) { toastError(e); }
        } }, 'Save'),
      });
    }

    function showEmailLogModal() {
      modal({
        title: 'Email delivery log',
        size: 'modal-lg',
        body: (async () => {
          const { log } = await get(`/api/admin/projects/${state.projectId}/email/log`);
          return log.length ? dataTable({ columns: [
            { key: 'created_at', label: 'Time', render: (r) => fmtDate(r.created_at) },
            { key: 'to', label: 'To' }, { key: 'subject', label: 'Subject' },
            { key: 'status', label: 'Status', render: (r) => badge(r.status.toUpperCase(), r.status === 'sent' ? 'green' : r.status === 'skipped' ? 'gray' : 'red') },
            { key: 'error', label: 'Error' },
          ], rows: log }) : emptyState({ title: 'No deliveries yet', icon: 'mail' });
        })(),
      });
    }

    function showOAuthModal(refresh) {
      const provider = h('select', { class: 'input' }, ...['google', 'github', 'discord'].map((p) => h('option', { value: p }, p)));
      const clientId = h('input', { class: 'input mono', placeholder: 'client id' });
      const clientSecret = h('input', { class: 'input mono', type: 'password', placeholder: 'client secret' });
      const redirect = h('input', { class: 'input mono', value: `${location.origin}/api/v1/${state.projectId}/auth/oauth/google/callback` });
      const scopes = h('input', { class: 'input mono', placeholder: 'openid email profile' });
      const redirectNote = () => { redirect.value = `${location.origin}/api/v1/${state.projectId}/auth/oauth/${provider.value}/callback`; };
      provider.addEventListener('change', redirectNote);
      const m = modal({
        title: 'Configure OAuth provider',
        size: 'modal-lg',
        body: h('div', {},
          field('Provider', provider),
          formRow(field('Client ID', clientId), field('Client secret', clientSecret)),
          field('Redirect URL (register this at the provider)', redirect),
          field('Scopes', scopes, { hint: 'Leave empty for provider defaults' })),
        footer: h('button', { class: 'btn btn-primary', onclick: async () => {
          try {
            await put(`/api/admin/projects/${state.projectId}/oauth`, {
              provider: provider.value, clientId: clientId.value, clientSecret: clientSecret.value,
              redirectUrl: redirect.value, scopes: scopes.value, enabled: true,
            });
            toastSuccess(`${provider.value} configured (secret encrypted at rest)`);
            m.close(); refresh();
          } catch (e) { toastError(e); }
        } }, 'Save provider'),
      });
    }

    function showTemplateModal(name) {
      (async () => {
        const tpl = await get(`/api/admin/projects/${state.projectId}/email/templates/${name}`);
        const subject = h('input', { class: 'input', value: tpl.subject });
        const html = h('textarea', { class: 'input mono', style: { minHeight: '220px' } });
        html.value = tpl.html;
        const m = modal({
          title: `Template — ${name}`,
          size: 'modal-xl',
          body: h('div', {}, field('Subject', subject), field('HTML body', html)),
          footer: h('button', { class: 'btn btn-primary', onclick: async () => {
            try { await put(`/api/admin/projects/${state.projectId}/email/templates/${name}`, { subject: subject.value, html: html.value }); toastSuccess('Template saved'); m.close(); }
            catch (e) { toastError(e); }
          } }, 'Save'),
        });
      })();
    }

    function go(hash) { location.hash = hash; }
  },
});

/* ═══ Users page ═════════════════════════════════════════════════════════ */
register('users', {
  title: 'Users',
  async render(page) {
    if (!requireProject(page, 'Users')) return;
    let offset = 0;
    const limit = 25;
    const search = h('input', { class: 'input', placeholder: 'Search by email…', style: { width: '240px' } });
    const container = h('div', {});

    async function load() {
      clear(container).append(h('div', { class: 'loading-block' }, h('div', { class: 'spinner' }), 'Loading users…'));
      try {
        const data = await get(`/api/admin/projects/${state.projectId}/auth/users?limit=${limit}&offset=${offset}&search=${encodeURIComponent(search.value || '')}`);
        clear(container);
        if (!data.users.length) {
          container.append(emptyState({
            title: 'No end-users yet',
            sub: `Users register through your project API: POST /api/v1/${state.projectId}/auth/register`,
            icon: 'users',
            action: h('button', { class: 'btn btn-secondary', onclick: () => showCreateUserModal(load) }, icon('plus'), 'Create user'),
          }));
          return;
        }
        container.append(dataTable({
          searchable: false,
          columns: [
            { key: 'email', label: 'Email' },
            { key: 'emailVerified', label: 'Verified', render: (u) => badge(u.emailVerified ? 'VERIFIED' : 'UNVERIFIED', u.emailVerified ? 'green' : 'gray') },
            { key: 'totpEnabled', label: 'MFA', render: (u) => u.totpEnabled ? 'TOTP ✓' : '—' },
            { key: 'disabled', label: 'Status', render: (u) => badge(u.disabled ? 'DISABLED' : 'ACTIVE', u.disabled ? 'red' : 'green') },
            { key: 'createdAt', label: 'Created', render: (u) => h('span', { class: 'cell-dim' }, fmtDate(u.createdAt)) },
            { key: 'lastLoginAt', label: 'Last login', render: (u) => h('span', { class: 'cell-dim' }, fmtDate(u.lastLoginAt)) },
          ],
          rows: data.users,
          onRowClick: (u) => showUserModal(u, load),
          rowActions: (u) => [h('button', { class: 'btn btn-ghost btn-sm', onclick: (e) => { e.stopPropagation(); showUserModal(u, load); } }, icon('edit'))],
          footer: () => h('div', { class: 'table-footer' },
            h('span', {}, `${fmtNumber(data.total)} users`),
            h('div', { style: { display: 'flex', gap: '6px' } },
              h('button', { class: 'btn btn-ghost btn-sm', disabled: offset === 0, onclick: () => { offset = Math.max(0, offset - limit); load(); } }, '←'),
              h('button', { class: 'btn btn-ghost btn-sm', disabled: offset + limit >= data.total, onclick: () => { offset += limit; load(); } }, '→'))),
        }));
      } catch (e) {
        clear(container);
        container.append(h('div', { class: 'error-box' }, e.message));
      }
    }

    page.append(
      h('div', { class: 'page-header' },
        h('div', {},
          h('h2', { class: 'page-title' }, 'Users'),
          h('p', { class: 'page-subtitle' }, 'End-user accounts for this project (dashboard admins live in Settings).')),
        h('div', { class: 'page-actions' },
          h('button', { class: 'btn btn-ghost', onclick: () => showAuthLogModal() }, icon('list'), 'Auth log'),
          h('button', { class: 'btn btn-primary', onclick: () => showCreateUserModal(load) }, icon('plus'), 'Create user'))),
      h('div', { class: 'table-toolbar' }, search, h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { offset = 0; load(); } }, icon('search'), 'Search')),
      container);
    load();

    function showCreateUserModal(load) {
      const email = h('input', { class: 'input', type: 'email' });
      const password = h('input', { class: 'input mono', placeholder: 'min 8 chars' });
      const m = modal({
        title: 'Create user',
        body: h('div', {}, field('Email', email), field('Password', password)),
        footer: h('button', { class: 'btn btn-primary', onclick: async () => {
          try { await post(`/api/admin/projects/${state.projectId}/auth/users`, { email: email.value, password: password.value }); toastSuccess('User created'); m.close(); load(); }
          catch (e) { toastError(e); }
        } }, 'Create'),
      });
    }

    function showUserModal(u, reload) {
      const claims = h('textarea', { class: 'input mono', style: { minHeight: '80px' } });
      claims.value = JSON.stringify(u.claims || {}, null, 2);
      const metadata = h('textarea', { class: 'input mono', style: { minHeight: '80px' } });
      metadata.value = JSON.stringify(u.metadata || {}, null, 2);
      const disabled = h('input', { type: 'checkbox' });
      disabled.checked = !!u.disabled;
      const verified = h('input', { type: 'checkbox' });
      verified.checked = !!u.emailVerified;
      const m = modal({
        title: `User — ${u.email}`,
        size: 'modal-lg',
        body: h('div', {},
          h('label', { class: 'checkbox-row', style: { marginBottom: '10px' } }, verified, 'Email verified'),
          h('label', { class: 'checkbox-row' }, disabled, 'Disabled (revokes sessions)'),
          field('Custom claims (merged into the user JWT)', claims),
          field('Metadata', metadata),
          h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
            const r = await post(`/api/admin/projects/${state.projectId}/auth/users/${u.id}/send-verification`);
            r.sent ? toastSuccess('Verification email sent') : toast(`SMTP not configured — token: ${r.token}`, { type: 'warn', timeout: 10000 });
          } }, icon('mail'), 'Resend verification email')),
        footer: [
          h('button', { class: 'btn btn-danger', onclick: async () => {
            const ok = await confirmDialog({ title: `Delete ${u.email}?`, message: 'The account is deactivated and sessions revoked. Purge removes all data.', confirmText: 'Delete', danger: true });
            if (!ok) return;
            try { await del(`/api/admin/projects/${state.projectId}/auth/users/${u.id}`); toastSuccess('User deleted'); m.close(); reload(); }
            catch (e) { toastError(e); }
          } }, 'Delete'),
          h('button', { class: 'btn btn-primary', onclick: async () => {
            const claimsObj = safeParse(claims.value, null);
            const metaObj = safeParse(metadata.value, null);
            if (claimsObj === null || metaObj === null) return toastError('Claims and metadata must be valid JSON');
            try {
              await patch(`/api/admin/projects/${state.projectId}/auth/users/${u.id}`, {
                disabled: disabled.checked, emailVerified: verified.checked, claims: claimsObj, metadata: metaObj,
              });
              toastSuccess('User updated'); m.close(); reload();
            } catch (e) { toastError(e); }
          } }, 'Save'),
        ],
      });
    }

    async function showAuthLogModal() {
      const { logs } = await get(`/api/admin/projects/${state.projectId}/auth/logs?limit=120`);
      modal({
        title: 'Authentication log',
        size: 'modal-xl',
        body: logs.length ? dataTable({
          columns: [
            { key: 'ts', label: 'Time', render: (r) => fmtDate(r.ts) },
            { key: 'event', label: 'Event', render: (r) => h('span', { class: 'cell-mono' }, r.event) },
            { key: 'email', label: 'Email' },
            { key: 'ip', label: 'IP', className: 'cell-dim' },
            { key: 'success', label: '', render: (r) => badge(r.success ? 'OK' : 'FAIL', r.success ? 'green' : 'red') },
          ],
          rows: logs,
        }) : emptyState({ title: 'No auth events yet', icon: 'shield' }),
      });
    }
  },
});
