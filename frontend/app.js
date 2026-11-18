// app.js — application bootstrap: auth/setup flow, topbar wiring (org /
// project / environment switchers, connect modal, command palette, theme),
// keyboard shortcuts and page-module registration.
import {
  state,
  auth,
  api,
  get,
  post,
  h,
  clear,
  qs,
  qsa,
  icon,
  dropdown,
  toast,
  toastSuccess,
  toastError,
  modal,
  field,
  formRow,
  copyChip,
  initTooltips,
  persistState,
  refreshProject,
  safeParse,
  playStartupSound,
} from './components.js';
import { start as startRouter, go, render as renderRoute, currentRoute } from './router.js';
import { renderSidebar } from './sidebar.js';

// page modules self-register their routes on import
import './dashboard.js';
import './projects.js';
import './database.js';
import './sql-editor.js';
import './nosql-editor.js';
import './authentication.js';
import './storage.js';
import './api-explorer.js';
import './realtime.js';
import './functions.js';
import './settings.js';
import './analytics.js';

/* ═══ Theme ═════════════════════════════════════════════════════════════ */
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
}
function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  persistState();
  applyTheme();
  renderRoute();
}

/* ═══ Auth screens ══════════════════════════════════════════════════════ */
function showAuthScreen() {
  qs('#auth-screen').classList.remove('hidden');
  qs('#shell').classList.add('hidden');
  renderAuthForms();
}

async function renderAuthForms() {
  const forms = qs('#auth-forms');
  clear(forms);
  let bootstrap = null;
  try {
    bootstrap = await get('/api/admin/bootstrap');
  } catch {
    forms.append(h('div', { class: 'callout danger' }, 'Cannot reach the Bloop backend at this address. Is the server running?'));
    return;
  }
  if (bootstrap.setupRequired) renderSetupForm(forms);
  else renderLoginForm(forms, bootstrap);
}

function renderSetupForm(forms) {
  const email = h('input', { class: 'input', type: 'email', placeholder: 'you@example.com', autocomplete: 'username' });
  const name = h('input', { class: 'input', placeholder: 'Your name', autocomplete: 'name' });
  const pw = h('input', { class: 'input', type: 'password', placeholder: 'At least 10 characters', autocomplete: 'new-password' });
  const pw2 = h('input', { class: 'input', type: 'password', placeholder: 'Repeat password', autocomplete: 'new-password' });
  const btn = h('button', { class: 'btn btn-primary btn-lg', style: { width: '100%' } }, 'Create owner account');
  const err = h('div', { class: 'field-error', style: { display: 'none' } });
  btn.addEventListener('click', async () => {
    err.style.display = 'none';
    if (!email.value.includes('@')) return fieldErr('Enter a valid email');
    if (pw.value.length < 10) return fieldErr('Password must be at least 10 characters');
    if (pw.value !== pw2.value) return fieldErr('Passwords do not match');
    btn.disabled = true; btn.classList.add('loading');
    try {
      const data = await post('/api/admin/setup', { email: email.value, password: pw.value, name: name.value });
      auth.token = data.accessToken; auth.refresh = data.refreshToken;
      await enterApp();
    } catch (e) {
      btn.disabled = false; btn.classList.remove('loading');
      fieldErr(e.message);
    }
  });
  function fieldErr(msg) { err.textContent = msg; err.style.display = 'block'; }
  forms.append(
    h('h2', { style: { fontSize: '17px', marginBottom: '4px' } }, 'Welcome to Bloop'),
    h('p', { style: { color: 'var(--text-muted)', fontSize: '13px', marginBottom: '18px' } }, 'First run: create the owner account for this instance. No default credentials exist.'),
    formRow(field('Name', name), field('Email', email)),
    field('Password', pw),
    field('Confirm password', pw2),
    err, btn,
    h('p', { class: 'hint', style: { textAlign: 'center', marginTop: '12px', color: 'var(--text-faint)', fontSize: '12px' } }, 'This account manages your self-hosted Bloop instance.'),
  );
}

function renderLoginForm(forms, bootstrap) {
  const email = h('input', { class: 'input', type: 'email', placeholder: 'you@example.com', autocomplete: 'username' });
  const pw = h('input', { class: 'input', type: 'password', placeholder: 'Your password', autocomplete: 'current-password' });
  const totpWrap = h('div', { style: { display: 'none' } }, field('2FA code (TOTP)', (() => { const t = h('input', { class: 'input mono', placeholder: '123456', inputmode: 'numeric' }); t.dataset.role = 'totp'; return t; })()));
  const btn = h('button', { class: 'btn btn-primary btn-lg', style: { width: '100%' } }, 'Sign in');
  const err = h('div', { class: 'field-error', style: { display: 'none' } });
  btn.addEventListener('click', submit);
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  async function submit() {
    err.style.display = 'none';
    btn.disabled = true; btn.classList.add('loading');
    try {
      const totp = qs('[data-role="totp"]', forms)?.value || undefined;
      const data = await post('/api/admin/login', { email: email.value, password: pw.value, totpCode: totp });
      if (data.mfaRequired) {
        totpWrap.style.display = 'block';
        btn.textContent = 'Verify code & sign in';
        btn.disabled = false; btn.classList.remove('loading');
        qs('[data-role="totp"]', forms)?.focus();
        return;
      }
      auth.token = data.accessToken; auth.refresh = data.refreshToken;
      await enterApp();
    } catch (e) {
      btn.disabled = false; btn.classList.remove('loading');
      err.textContent = e.message; err.style.display = 'block';
    }
  }
  forms.append(
    h('h2', { style: { fontSize: '17px', marginBottom: '4px' } }, 'Sign in to Bloop'),
    h('p', { style: { color: 'var(--text-muted)', fontSize: '13px', marginBottom: '18px' } }, bootstrap?.platform ? `Managing “${bootstrap.platform}” — self-hosted instance` : 'Dashboard login'),
    field('Email', email),
    field('Password', pw),
    totpWrap,
    err, btn,
  );
}

/* ═══ Enter the app ══════════════════════════════════════════════════════ */
async function enterApp() {
  const me = await get('/api/admin/me');
  state.admin = me.admin;
  state.orgs = me.orgs || [];
  state.orgId = state.orgs[0]?.id || null;
  const projectsData = await get('/api/admin/projects');
  state.projects = projectsData.projects || [];
  if (!state.projectId || !state.projects.find((p) => p.id === state.projectId)) {
    state.projectId = state.projects[0]?.id || null;
  }
  await refreshProject();

  qs('#auth-screen').classList.add('hidden');
  qs('#shell').classList.remove('hidden');
  applyTheme();
  wireTopbar();
  initTooltips();
  wireCommandPalette();
  wireShortcuts();
  playStartupSound(); // dashboard is up — play the startup sound (if provided)

  renderSidebar();
  startRouter();
  renderSidebar(); // re-render with active route highlighted
}

/* ═══ Topbar ═════════════════════════════════════════════════════════════ */
function wireTopbar() {
  dropdown(qs('#org-switcher'));
  dropdown(qs('#project-switcher'));
  dropdown(qs('#env-switcher'));
  dropdown(qs('#user-menu-wrap'));

  qs('#brand-btn').addEventListener('click', () => go('overview'));
  qs('#theme-btn').addEventListener('click', toggleTheme);
  qs('#search-btn').addEventListener('click', () => openPalette());
  qs('#connect-btn').addEventListener('click', openConnectModal);
  qs('#user-avatar').addEventListener('click', renderUserMenu);
  qs('#org-btn').addEventListener('click', renderOrgMenu);
  qs('#project-btn').addEventListener('click', renderProjectMenu);
  qs('#env-btn').addEventListener('click', renderEnvMenu);
  updateTopbarLabels();
}

function updateTopbarLabels() {
  const org = state.orgs.find((o) => o.id === state.orgId);
  qs('#org-name').textContent = org?.name || 'Organization';
  qs('#project-name').textContent = state.project?.name || 'No project';
  qs('#env-name').textContent = state.env === 'dev' ? 'main' : state.env;
  const badge = qs('#env-badge');
  badge.textContent = state.env.toUpperCase();
  badge.dataset.env = state.env;
  const initial = (state.admin?.name || state.admin?.email || '?').trim()[0]?.toUpperCase() || '?';
  qs('#user-initial').textContent = initial;
}

function renderOrgMenu() {
  const menu = qs('#org-menu');
  clear(menu);
  for (const org of state.orgs) {
    menu.append(h('button', { class: `menu-item ${org.id === state.orgId ? 'selected' : ''}`, onclick: async () => {
      state.orgId = org.id;
      const data = await get('/api/admin/projects');
      state.projects = data.projects || [];
      state.projectId = state.projects[0]?.id || null;
      await refreshProject();
      persistState();
      updateTopbarLabels();
      renderRoute();
    } }, icon('users'), h('div', {}, h('div', {}, org.name), h('div', { class: 'menu-sub' }, `${org.role} · ${org.projects_count ?? ''} projects`))));
  }
  menu.append(h('div', { class: 'menu-sep' }), h('button', { class: 'menu-item', onclick: () => go('projects') }, icon('plus'), 'Manage organizations'));
}

function renderProjectMenu() {
  const menu = qs('#project-menu');
  clear(menu);
  for (const p of state.projects.slice(0, 30)) {
    menu.append(h('button', { class: `menu-item ${p.id === state.projectId ? 'selected' : ''}`, onclick: async () => {
      state.projectId = p.id;
      persistState();
      await refreshProject();
      updateTopbarLabels();
      renderRoute();
    } }, icon('layers'), h('div', {}, h('div', {}, p.name), h('div', { class: 'menu-sub' }, p.slug))));
  }
  menu.append(h('div', { class: 'menu-sep' }),
    h('button', { class: 'menu-item', onclick: () => go('projects') }, icon('plus'), 'New project / manage'));
}

function renderEnvMenu() {
  const menu = qs('#env-menu');
  clear(menu);
  menu.append(h('div', { class: 'menu-header' }, 'Environment'));
  for (const env of ['dev', 'staging', 'prod']) {
    const labels = { dev: ['main', 'Development'], staging: ['staging', 'Staging'], prod: ['main', 'Production'] };
    menu.append(h('button', { class: `menu-item ${env === state.env ? 'selected' : ''}`, onclick: () => {
      state.env = env;
      persistState();
      updateTopbarLabels();
      renderRoute();
    } }, icon('branch'), h('div', {}, h('div', { class: 'mono' }, labels[env][0]), h('div', { class: 'menu-sub' }, labels[env][1]))));
  }
}

function renderUserMenu() {
  const menu = qs('#user-menu');
  clear(menu);
  menu.append(
    h('div', { class: 'menu-header' }, state.admin?.email || ''),
    h('button', { class: 'menu-item', onclick: () => { qs('#user-menu-wrap').classList.remove('open'); go('settings'); } }, icon('settings'), 'Settings'),
    h('button', { class: 'menu-item', onclick: () => { qs('#user-menu-wrap').classList.remove('open'); toggleTheme(); } }, icon('eye'), 'Toggle theme'),
    h('div', { class: 'menu-sep' }),
    h('button', {
      class: 'menu-item danger', onclick: async () => {
        try { await post('/api/admin/logout', { refreshToken: auth.refresh }); } catch { }
        auth.clear();
        location.reload();
      },
    }, icon('x'), 'Sign out'),
  );
}

/* ═══ Connect modal (base URL + keys + curl) ═════════════════════════════ */
async function openConnectModal() {
  if (!state.projectId) return toastError('Select a project first');
  let keys = null;
  try { keys = await get(`/api/admin/projects/${state.projectId}/keys/reveal`); }
  catch (e) { return toastError(e.message); }
  const baseUrl = `${location.origin}`;
  const body = h('div', {},
    h('div', { class: 'field' }, h('label', {}, 'Project ID'), copyChip(state.projectId)),
    h('div', { class: 'field' }, h('label', {}, 'API base URL'), copyChip(baseUrl)),
    h('div', { class: 'field' }, h('label', {}, 'anon key (safe for browsers)'), copyChip(keys.anon)),
    h('div', { class: 'field' }, h('label', {}, 'service_role key (server-side only — bypasses row security)'), copyChip(keys.service)),
    h('div', { class: 'callout warn', style: { marginTop: '8px' } }, 'Never ship the service_role key to browsers or mobile apps.'),
    h('div', { class: 'field', style: { marginTop: '14px' } }, h('label', {}, 'Quick test'),
      h('pre', { class: 'json-view', style: { maxHeight: '160px' } },
        `curl ${baseUrl}/api/v1/${state.projectId}/db/\\
  -H "Authorization: Bearer ${keys.anon.slice(0, 18)}…"`)));
  modal({ title: 'Connect to your project', body, size: 'modal-lg' });
}

/* ═══ Command palette ════════════════════════════════════════════════════ */
const PALETTE_ITEMS = [
  { group: 'Navigate', label: 'Overview', icon: 'home', run: () => go('overview') },
  { group: 'Navigate', label: 'Projects', icon: 'layers', run: () => go('projects') },
  { group: 'Navigate', label: 'Database', icon: 'database', run: () => go('database') },
  { group: 'Navigate', label: 'SQL Editor', icon: 'terminal', run: () => go('sql') },
  { group: 'Navigate', label: 'NoSQL Explorer', icon: 'braces', run: () => go('nosql') },
  { group: 'Navigate', label: 'Authentication', icon: 'shield', run: () => go('authentication') },
  { group: 'Navigate', label: 'Users', icon: 'users', run: () => go('users') },
  { group: 'Navigate', label: 'Storage', icon: 'archive', run: () => go('storage') },
  { group: 'Navigate', label: 'API Explorer', icon: 'globe', run: () => go('api') },
  { group: 'Navigate', label: 'GraphQL', icon: 'plug', run: () => go('graphql') },
  { group: 'Navigate', label: 'Realtime', icon: 'radio', run: () => go('realtime') },
  { group: 'Navigate', label: 'Functions', icon: 'zap', run: () => go('functions') },
  { group: 'Navigate', label: 'Webhooks', icon: 'webhook', run: () => go('webhooks') },
  { group: 'Navigate', label: 'Analytics', icon: 'chart', run: () => go('analytics') },
  { group: 'Navigate', label: 'Logs', icon: 'list', run: () => go('logs') },
  { group: 'Navigate', label: 'Backups', icon: 'save', run: () => go('backups') },
  { group: 'Navigate', label: 'Plugins', icon: 'package2', run: () => go('plugins') },
  { group: 'Navigate', label: 'Settings', icon: 'settings', run: () => go('settings') },
  { group: 'Actions', label: 'Toggle dark / light theme', icon: 'eye', run: toggleTheme },
  { group: 'Actions', label: 'New project', icon: 'plus', run: () => go('projects') },
  { group: 'Actions', label: 'Connection info & API keys', icon: 'key', run: () => openConnectModal() },
];

function wireCommandPalette() {
  const overlay = qs('#command-palette');
  const input = qs('#cmdk-input');
  const results = qs('#cmdk-results');
  let highlighted = 0;

  function open() {
    overlay.classList.remove('hidden');
    input.value = '';
    input.focus();
    renderList('');
  }
  function close() { overlay.classList.add('hidden'); }

  function renderList(filter) {
    clear(results);
    const f = filter.toLowerCase();
    const items = PALETTE_ITEMS.filter((i) => i.label.toLowerCase().includes(f));
    highlighted = Math.min(highlighted, Math.max(0, items.length - 1));
    items.forEach((item, i) => {
      results.append(h('div', {
        class: `cmdk-item ${i === highlighted ? 'highlighted' : ''}`,
        onclick: () => { close(); item.run(); },
      }, icon(item.icon), h('span', {}, item.label), h('span', { class: 'cmdk-group' }, item.group)));
    });
    if (!items.length) results.append(h('div', { style: { padding: '14px', color: 'var(--text-faint)' } }, 'No matching commands'));
    results._items = items;
  }

  window.openPalette = open;
  qs('#search-btn').addEventListener('click', open);
  input.addEventListener('input', () => renderList(input.value));
  input.addEventListener('keydown', (e) => {
    const items = results._items || [];
    if (e.key === 'ArrowDown') { highlighted = Math.min(highlighted + 1, items.length - 1); renderList(input.value); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { highlighted = Math.max(highlighted - 1, 0); renderList(input.value); e.preventDefault(); }
    else if (e.key === 'Enter') { items[highlighted]?.run(); close(); }
    else if (e.key === 'Escape') close();
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

function wireShortcuts() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      window.openPalette?.();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      const btn = qs('[data-role="save-btn"]');
      if (btn) { e.preventDefault(); btn.click(); }
    }
  });
  // mobile sidebar toggle
  const topbarLeft = qs('.topbar-left');
  if (!qs('.sidebar-mobile-btn')) {
    topbarLeft.prepend(h('button', { class: 'sidebar-mobile-btn icon-btn', onclick: () => qs('#sidebar').classList.toggle('open') }, icon('menu')));
  }
}

/* ═══ Boot ═══════════════════════════════════════════════════════════════ */
(async function boot() {
  applyTheme();
  if (!auth.token) {
    showAuthScreen();
    return;
  }
  try {
    await enterApp();
  } catch (err) {
    if (err.status === 401) {
      auth.clear();
      showAuthScreen();
    } else {
      qs('#auth-screen').classList.remove('hidden');
      qs('#shell').classList.add('hidden');
      qs('#auth-forms').append(h('div', { class: 'callout danger' }, `Failed to load dashboard: ${err.message}`));
    }
  }
})();
