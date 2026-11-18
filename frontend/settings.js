// settings.js — two pages: Settings (server config, security, backups,
// logging, docker providers, config file, admin account & 2FA) and Plugins
// (installed plugins, local marketplace, install/enable/disable/config).
import {
  h, clear, get, post, patch, del, put, icon, state, toast, toastSuccess,
  toastError, modal, field, formRow, emptyState, badge, fmtDate, dataTable,
  confirmDialog, copyChip, jsonView, checkboxRow, fmtBytes, playStartupSound,
} from './components.js';
import { register } from './router.js';

/* ═══ Settings page ══════════════════════════════════════════════════════ */
register('settings', {
  title: 'Settings',
  projectScoped: false,
  async render(page) {
    const { config } = await get('/api/admin/config');
    const { settings } = await get('/api/admin/settings');
    const health = await get('/api/admin/health/detailed');
    const me = await get('/api/admin/me');

    const serverCard = h('div', { class: 'card' },
      h('div', { class: 'card-header' }, h('div', {},
        h('div', { class: 'card-title' }, 'Server'),
        h('div', { class: 'card-sub' }, 'Effective configuration (config/default-config.json + config/config.json + environment)')),
      ),
      h('div', { class: 'kv-list' },
        h('dt', {}, 'Host'), h('dd', {}, `${config.server.host}:${config.server.port}`),
        h('dt', {}, 'Mode'), h('dd', {}, state.admin ? '' : '', new URLSearchParams(location.search).get('env') || 'production'),
        h('dt', {}, 'Node'), h('dd', {}, navigator.userAgent.includes('Chrome') ? 'see /api/version' : '—'),
        h('dt', {}, 'Data dir'), h('dd', {}, 'storage/'),
        h('dt', {}, 'Embedded SQLite'), h('dd', {}, String(config.database.sqliteEnabled)),
        h('dt', {}, 'Max body size'), h('dd', {}, `${config.security.maxBodySize ?? '—'}`)),
      h('button', { class: 'btn btn-secondary btn-sm', style: { marginTop: '12px' }, onclick: () => showConfigEditor(config) }, icon('edit'), 'Edit config file'));

    const securityCard = h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-header' }, h('div', {},
        h('div', { class: 'card-title' }, 'Security & CORS'),
        h('div', { class: 'card-sub' }, 'Rate limits, CORS origins and body limits — validated before applying'))),
      (() => {
        const cors = h('textarea', { class: 'input mono', style: { minHeight: '56px' } });
        cors.value = (config.security.corsOrigins || []).join(', ');
        const rlMax = h('input', { class: 'input mono', type: 'number', value: config.security.rateLimit?.max || 600 });
        const rlWindow = h('input', { class: 'input mono', type: 'number', value: config.security.rateLimit?.windowMs || 60000 });
        return h('div', {},
          field('CORS origins (comma-separated, * allowed)', cors),
          formRow(field('Rate limit — max requests', rlMax), field('Window (ms)', rlWindow)),
          h('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
            try {
              await patch('/api/admin/config', {
                security: {
                  corsOrigins: cors.value.split(',').map((s) => s.trim()).filter(Boolean),
                  rateLimit: { max: Number(rlMax.value), windowMs: Number(rlWindow.value) },
                },
              });
              toastSuccess('Configuration saved and validated');
            } catch (e) { toastError(e); }
          } }, 'Save security settings'));
      })());

    const accountCard = h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-header' }, h('div', {},
        h('div', { class: 'card-title' }, 'Admin account'),
        h('div', { class: 'card-sub' }, `${me.admin.email} · role: ${me.admin.role} · MFA: ${me.admin.totp_enabled ? 'enabled' : 'disabled'}`))),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button', { class: 'btn btn-ghost btn-sm', onclick: () => showPasswordModal() }, icon('lock'), 'Change password'),
        !me.admin.totp_enabled
          ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => showTotpEnroll(me) }, icon('shield'), 'Enable 2FA (TOTP)')
          : h('button', { class: 'btn btn-ghost btn-sm', onclick: () => showTotpDisable(me) }, icon('shield'), 'Disable 2FA')));

    const envChips = h('div', { class: 'grid grid-3', style: { marginTop: '14px' } },
      ...['dev', 'staging', 'prod'].map((env) => h('div', { class: 'tile-card' },
        h('div', { class: `tile-icon ${state.env === env ? 'green' : ''}` }, icon('branch')),
        h('div', {},
          h('div', { class: 'tile-title mono' }, env),
          h('div', { class: 'tile-sub' }, `selected: ${state.env === env ? 'yes' : 'no'}`),
          h('button', { class: 'btn btn-ghost btn-sm', style: { marginTop: '4px' }, onclick: () => {
            state.env = env;
            localStorage.setItem('bloop.env', env);
            toastSuccess(`Environment switched to ${env} — connection and var views are env-scoped`);
          } }, 'Select')))));

    const prefCard = h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-header' }, h('div', {},
        h('div', { class: 'card-title' }, 'Dashboard preferences'),
        h('div', { class: 'card-sub' }, 'Stored locally in this browser — drop a startup.mp3 (or .wav / .ogg) into frontend/assets/ to enable it'))),
      h('div', { style: { padding: '0 16px 16px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
        (() => {
          const cb = h('input', { type: 'checkbox', id: 'pref-startup-sound' });
          cb.checked = localStorage.getItem('bloop.startupSound') !== '0';
          cb.addEventListener('change', () => localStorage.setItem('bloop.startupSound', cb.checked ? '1' : '0'));
          return cb;
        })(),
        h('label', { for: 'pref-startup-sound', style: { fontSize: '13.5px', color: 'var(--text)' } }, 'Play the startup sound when the dashboard opens'),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: () => playStartupSound(true) }, icon('play'), 'Test')));

    page.append(
      h('div', { class: 'page-header' },
        h('div', {},
          h('h2', { class: 'page-title' }, 'Settings'),
          h('p', { class: 'page-subtitle' }, 'Platform configuration. Sensitive values are masked; every change is validated before it is applied.')),
        h('div', { class: 'page-actions' },
          h('button', { class: 'btn btn-ghost', onclick: () => showHealthModal(health) }, icon('activity'), 'Health detail'),
          h('button', { class: 'btn btn-secondary', onclick: () => showBackupsSettings() }, icon('save'), 'Backup settings'),
          h('button', { class: 'btn btn-secondary', onclick: () => showDockerModal() }, icon('package2'), 'Docker providers'))),
      serverCard, securityCard, accountCard, envChips);

    function showPasswordModal() {
      const current = h('input', { class: 'input', type: 'password' });
      const next = h('input', { class: 'input', type: 'password', placeholder: 'min 10 chars' });
      const m = modal({
        title: 'Change password',
        body: h('div', {}, field('Current password', current), field('New password', next)),
        footer: h('button', { class: 'btn btn-primary', onclick: async () => {
          try { await post('/api/admin/me/password', { currentPassword: current.value, newPassword: next.value }); toastSuccess('Password changed'); m.close(); }
          catch (e) { toastError(e); }
        } }, 'Change'),
      });
    }

    function showTotpEnroll(me) {
      (async () => {
        const { secret, otpauthUrl } = await post('/api/admin/me/totp/enroll');
        const code = h('input', { class: 'input mono', placeholder: '123456' });
        const m = modal({
          title: 'Enable two-factor authentication',
          body: h('div', {},
            h('div', { class: 'callout', style: { marginBottom: '12px' } }, 'Add this secret to your authenticator app (Aegis, 1Password, Google Authenticator…):'),
            h('div', { class: 'field' }, h('label', {}, 'Secret'), copyChip(secret)),
            h('div', { class: 'field' }, h('label', {}, 'otpauth URL'), copyChip(otpauthUrl, otpauthUrl.slice(0, 48) + '…')),
            field('Enter the 6-digit code to confirm', code)),
          footer: h('button', { class: 'btn btn-primary', onclick: async () => {
            try { await post('/api/admin/me/totp/enable', { code: code.value }); toastSuccess('2FA enabled — you will be asked for a code at next login'); m.close(); render(page); }
            catch (e) { toastError(e); }
          } }, 'Enable'),
        });
      })();
    }

    function showTotpDisable(me) {
      const pw = h('input', { class: 'input', type: 'password' });
      const m = modal({
        title: 'Disable 2FA',
        body: field('Confirm with your password', pw),
        footer: h('button', { class: 'btn btn-danger', onclick: async () => {
          try { await post('/api/admin/me/totp/disable', { password: pw.value }); toastSuccess('2FA disabled'); m.close(); render(page); }
          catch (e) { toastError(e); }
        } }, 'Disable'),
      });
    }

    function showConfigEditor(config) {
      const ta = h('textarea', { class: 'input mono', style: { minHeight: '320px' } });
      ta.value = JSON.stringify(config, null, 2);
      const m = modal({
        title: 'Effective configuration (config.json layer)',
        size: 'modal-xl',
        body: field('JSON', ta, { hint: 'Saved to config/config.json. Host/port need a restart. Values are validated before apply.' }),
        footer: h('button', { class: 'btn btn-primary', onclick: async () => {
          const patchObj = safeParse(ta.value, null);
          if (patchObj === null) return toastError('Not valid JSON');
          try {
            const r = await patch('/api/admin/config', patchObj);
            if (r.valid) toastSuccess('Config applied' + (r.note ? ' — ' + r.note : ''));
            else toastError(r.errors?.join('; ') || 'Validation failed');
            m.close(); render(page);
          } catch (e) { toastError(e); }
        } }, 'Validate & apply'),
      });
    }

    function showHealthModal(health) {
      modal({
        title: `Health — ${health.status}`,
        size: 'modal-lg',
        body: dataTable({
          columns: [
            { key: 'name', label: 'Check', className: 'cell-mono' },
            { key: 'status', label: 'Status', render: (c) => badge(c.status.toUpperCase(), c.status === 'ok' ? 'green' : 'red') },
            { key: 'detail', label: 'Detail', render: (c) => h('span', { class: 'cell-dim mono', style: { fontSize: '11.5px' } }, typeof c.detail === 'object' ? JSON.stringify(c.detail) : String(c.detail ?? '')) },
            { key: 'durationMs', label: 'Time', render: (c) => `${c.durationMs}ms` },
          ],
          rows: health.checks,
        }),
      });
    }

    function showBackupsSettings() {
      const maxCount = h('input', { class: 'input mono', type: 'number', value: config.backups?.retention?.maxCount || 30 });
      const days = h('input', { class: 'input mono', type: 'number', value: config.backups?.retention?.days || 90 });
      const schedule = h('input', { class: 'input mono', value: config.backups?.defaultSchedule || '0 3 * * *', placeholder: '0 3 * * *' });
      const encrypt = h('input', { type: 'checkbox' });
      encrypt.checked = !!config.backups?.encryptByDefault;
      const m = modal({
        title: 'Backup defaults',
        size: 'modal-lg',
        body: h('div', {},
          formRow(field('Retention — max backups', maxCount), field('Retention — days', days)),
          field('Default cron schedule', schedule, { hint: 'Per-project schedules can differ (Backups page)' }),
          checkboxRowEl(encrypt, 'Encrypt backups by default (AES-256-GCM — needs the master key to restore)')),
        footer: h('button', { class: 'btn btn-primary', onclick: async () => {
          try {
            await patch('/api/admin/config', { backups: { retention: { maxCount: Number(maxCount.value), days: Number(days.value) }, defaultSchedule: schedule.value, encryptByDefault: encrypt.checked } });
            toastSuccess('Backup defaults saved'); m.close();
          } catch (e) { toastError(e); }
        } }, 'Save'),
      });
    }

    async function showDockerModal() {
      const status = await get('/api/admin/docker/status');
      const services = h('div', {});
      for (const svc of ['postgres', 'mysql', 'mariadb', 'mongodb', 'minio', 'badger']) {
        const cb = h('input', { type: 'checkbox' });
        services.append(checkboxRowEl(cb, svc));
      }
      modal({
        title: `Docker — ${status.ok ? `available (server ${status.version})` : 'not available on this host'}`,
        size: 'modal-lg',
        body: h('div', {},
          status.ok ? null : h('div', { class: 'callout warn', style: { marginBottom: '12px' } }, status.reason || 'Docker CLI not found — provider services must be hosted elsewhere.'),
          status.containers?.length ? h('div', { class: 'micro', style: { margin: '6px 0' } }, 'Running containers') : null,
          status.containers?.map((c) => h('div', { class: 'cell-mono', style: { padding: '3px 0' } }, `${c.name} · ${c.image} · ${c.status}`)),
          h('div', { class: 'micro', style: { margin: '14px 0 6px' } }, 'Generate docker compose snippet for providers'),
          services,
          h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => {
            const selected = [...services.querySelectorAll('input:checked')].map((cb) => cb.parentElement.textContent.trim());
            if (!selected.length) return toastError('Select at least one service');
            try {
              const r = await post('/api/admin/docker/compose', { services: selected });
              modal({ title: 'Generated compose file', size: 'modal-xl', body: h('div', {},
                h('div', { class: 'cell-dim', style: { marginBottom: '8px' } }, `Written to ${r.path}`),
                h('pre', { class: 'json-view', style: { maxHeight: '340px' } }, r.content)) });
            } catch (e) { toastError(e); }
          } }, 'Generate compose file')),
      });
    }

    function checkboxRowEl(cb, label) {
      return h('label', { class: 'checkbox-row', style: { marginBottom: '10px' } }, cb, label);
    }
  },
});

/* ═══ Plugins page ═══════════════════════════════════════════════════════ */
register('plugins', {
  title: 'Plugins',
  projectScoped: false,
  async render(page) {
    const [{ plugins, discovered }, marketplace] = await Promise.all([
      get('/api/admin/plugins'),
      get('/api/admin/marketplace'),
    ]);

    const installedCard = h('div', { class: 'card', style: { marginBottom: '14px' } },
      h('div', { class: 'card-header' }, h('div', {},
        h('div', { class: 'card-title' }, 'Installed plugins'),
        h('div', { class: 'card-sub' }, 'Plugins declare permissions; anything they register is scoped accordingly')),
        h('button', { class: 'btn btn-secondary btn-sm', onclick: () => showInstallModal(render) }, icon('upload'), 'Install from path or .zip')),
      plugins.length || discovered.length ? dataTable({
        columns: [
          { key: 'name', label: 'Plugin' },
          { key: 'version', label: 'Version' },
          { key: 'permissions', label: 'Permissions', render: (p) => h('span', { class: 'cell-dim mono', style: { fontSize: '11px' } }, (p.permissions || p.manifest?.permissions || []).join(', ') || '—') },
          { key: 'enabled', label: 'State', render: (p) => {
            const on = p.enabled !== undefined ? !!p.enabled : p.active;
            return badge(on ? 'ACTIVE' : 'DISABLED', on ? 'green' : 'gray');
          } },
        ],
        rows: [
          ...plugins.map((p) => ({ ...p, description: p.manifest?.description || p.description || '' })),
          ...discovered.filter((d) => !plugins.find((p) => p.name === d.name)).map((d) => ({ ...d, enabled: false, discoveredOnly: true })),
        ],
        rowActions: (p) => [
          p.enabled
            ? h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
              await post(`/api/admin/plugins/${p.name}/disable`);
              toastSuccess(`${p.name} disabled`); render(page);
            } }, 'Disable')
            : h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
              try { await post(`/api/admin/plugins/${p.name}/enable`); toastSuccess(`${p.name} enabled (routes register at load)`); render(page); }
              catch (e) { toastError(e); }
            } }, 'Enable'),
          h('button', { class: 'btn btn-ghost btn-sm', onclick: () => showPluginConfigModal(p) }, icon('settings')),
          h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
            const ok = await confirmDialog({ title: `Uninstall ${p.name}?`, message: 'The plugin record is removed; its folder stays on disk for review.', confirmText: 'Uninstall', danger: true });
            if (!ok) return;
            await post(`/api/admin/plugins/${p.name}/uninstall`);
            toastSuccess('Plugin uninstalled'); render(page);
          } }, icon('trash')),
        ],
      }) : emptyState({
        title: 'No plugins installed',
        sub: 'Plugins live in the plugins/ directory with a manifest.json (name, version, permissions) and an index.js exporting register(ctx).',
        icon: 'package2',
      }));

    const marketplaceCard = h('div', { class: 'card' },
      h('div', { class: 'card-header' }, h('div', {},
        h('div', { class: 'card-title' }, 'Marketplace'),
        h('div', { class: 'card-sub' }, marketplace.remoteRegistry
          ? `Registry: ${marketplace.remoteRegistry}`
          : 'No remote registry configured — the local catalog below is what ships with this instance. Point settings key marketplace.remoteRegistryUrl at a registry to populate this list.'))),
      (marketplace.plugins || []).length ? dataTable({
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'version', label: 'Version' },
          { key: 'description', label: 'Description' },
        ],
        rows: marketplace.plugins,
      }) : emptyState({ title: 'Marketplace is empty (honestly)', sub: 'Install plugins locally from a folder path or a .zip — no fake listings.', icon: 'package2' }));

    page.append(
      h('div', { class: 'page-header' },
        h('div', {},
          h('h2', { class: 'page-title' }, 'Plugins'),
          h('p', { class: 'page-subtitle' }, 'Extend Bloop with database providers, auth providers, routes and event handlers — loaded in-process with declared permissions.')),
        h('div', { class: 'page-actions' },
          h('button', { class: 'btn btn-ghost', onclick: () => location.hash = '#/settings' }, icon('settings'), 'Platform settings'))),
      installedCard, marketplaceCard);

    function showInstallModal(refresh) {
      const path = h('input', { class: 'input mono', placeholder: '/absolute/path/to/plugin-folder' });
      const file = h('input', { type: 'file', accept: '.zip', style: { display: 'none' } });
      const enable = h('input', { type: 'checkbox' });
      enable.checked = true;
      const m = modal({
        title: 'Install plugin',
        size: 'modal-lg',
        body: h('div', {},
          field('Folder path (on the server)', path),
          h('div', { style: { margin: '8px 0' } }, h('button', { class: 'btn btn-secondary btn-sm', onclick: () => file.click() }, icon('upload'), '…or upload a .zip')),
          checkboxRowEl(enable, 'Enable immediately')),
        footer: h('button', { class: 'btn btn-primary', onclick: async () => {
          try {
            if (file.files[0]) {
              const fd = new FormData();
              fd.append('file', file.files[0]);
              fd.append('enable', enable.checked ? 'true' : 'false');
              const res = await fetch('/api/admin/marketplace/install', {
                method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('bloop.adminToken')}` }, body: fd,
              });
              if (!res.ok) throw new Error((await res.json())?.error?.message || 'Install failed');
              toastSuccess('Plugin installed from zip');
            } else if (path.value.trim()) {
              await post('/api/admin/marketplace/install', { path: path.value.trim(), enable: enable.checked });
              toastSuccess('Plugin installed');
            } else return toastError('Provide a path or a zip file');
            m.close(); refresh();
          } catch (e) { toastError(e); }
        } }, 'Install'),
      });
      file.addEventListener('change', () => { void file; });
    }

    function showPluginConfigModal(p) {
      (async () => {
        const { config } = await get(`/api/admin/plugins/${p.name}/config`);
        const ta = h('textarea', { class: 'input mono', style: { minHeight: '160px' } });
        ta.value = JSON.stringify(config || {}, null, 2);
        const m = modal({
          title: `Plugin config — ${p.name}`,
          size: 'modal-lg',
          body: field('Config values (string values are encrypted at rest)', ta),
          footer: h('button', { class: 'btn btn-primary', onclick: async () => {
            const obj = safeParse(ta.value, null);
            if (obj === null) return toastError('Config must be a JSON object');
            try { await put(`/api/admin/plugins/${p.name}/config`, obj); toastSuccess('Plugin config saved'); m.close(); }
            catch (e) { toastError(e); }
          } }, 'Save'),
        });
      })();
    }
  },
});
