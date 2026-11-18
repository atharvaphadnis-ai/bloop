// components.js — shared foundation for every page: API client, global state,
// DOM helpers, icons, toasts, modals, tables, tabs, dropdowns, forms,
// skeletons, empty states, tooltips, context menus and small chart helpers.

/* ═══ Global state ═══════════════════════════════════════════════════════ */
export const state = {
  admin: null,
  orgs: [],
  orgId: null,
  projects: [],
  projectId: localStorage.getItem('bloop.projectId') || null,
  env: localStorage.getItem('bloop.env') || 'dev',
  theme: localStorage.getItem('bloop.theme') || 'dark',
  project: null,
};

export function persistState() {
  if (state.projectId) localStorage.setItem('bloop.projectId', state.projectId);
  localStorage.setItem('bloop.env', state.env);
  localStorage.setItem('bloop.theme', state.theme);
}

/* ═══ API client ═════════════════════════════════════════════════════════ */
const TOKEN_KEY = 'bloop.adminToken';
const REFRESH_KEY = 'bloop.adminRefresh';

export const auth = {
  get token() { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || null; },
  set token(v) { if (v === null) { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); } else localStorage.setItem(TOKEN_KEY, v); },
  get refresh() { return localStorage.getItem(REFRESH_KEY) || null; },
  set refresh(v) { if (v === null) localStorage.removeItem(REFRESH_KEY); else localStorage.setItem(REFRESH_KEY, v); },
  clear() { this.token = null; this.refresh = null; },
};

let refreshingPromise = null;

async function raw(path, { method = 'GET', body, headers = {}, raw = false, formData = null } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(formData ? {} : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
      ...headers,
    },
    body: formData ? formData : body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((data?.error?.message) || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.error?.code;
    err.details = data?.error?.details;
    throw err;
  }
  return raw ? res : data;
}

export async function api(path, opts = {}) {
  try {
    return await raw(path, opts);
  } catch (err) {
    if (err.status === 401 && auth.refresh && !path.includes('/auth/refresh') && !path.includes('/admin/login')) {
      // single-flight session refresh then retry once
      refreshingPromise = refreshingPromise || raw('/api/admin/refresh', { method: 'POST', body: { refreshToken: auth.refresh } })
        .then((data) => { auth.token = data.accessToken; auth.refresh = data.refreshToken; state.admin = data.admin; })
        .finally(() => { refreshingPromise = null; });
      try {
        await refreshingPromise;
        return await raw(path, opts);
      } catch {
        // Multi-tab rotation race: another tab may have rotated the refresh
        // token a moment ago. Wait, re-read localStorage via the getter and
        // retry once before bouncing to the login screen.
        try {
          await new Promise((r) => setTimeout(r, 450));
          refreshingPromise = raw('/api/admin/refresh', { method: 'POST', body: { refreshToken: auth.refresh } })
            .then((data) => { auth.token = data.accessToken; auth.refresh = data.refreshToken; state.admin = data.admin; })
            .finally(() => { refreshingPromise = null; });
          await refreshingPromise;
          return await raw(path, opts);
        } catch { auth.clear(); location.reload(); }
      }
    }
    throw err;
  }
}

export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const patch = (p, body) => api(p, { method: 'PATCH', body });
export const del = (p, body) => api(p, { method: 'DELETE', body });

/* ═══ Startup sound ══════════════════════════════════════════════════════ */
let startupAudio = false; // false = unresolved, null = no sound file present
export async function resolveStartupAudio() {
  if (startupAudio !== false) return startupAudio;
  try {
    const { src } = await get('/api/admin/startup-sound');
    startupAudio = src ? Object.assign(new Audio(src), { volume: 0.45 }) : null;
  } catch { startupAudio = null; }
  return startupAudio;
}
export async function playStartupSound(force = false) {
  if (!force && localStorage.getItem('bloop.startupSound') === '0') return;
  const audio = await resolveStartupAudio();
  if (!audio) return;
  try {
    audio.currentTime = 0;
    await audio.play();
  } catch {
    // browser autoplay policy — retry once on the next user gesture
    const retry = () => { audio.currentTime = 0; audio.play().catch(() => {}); };
    document.addEventListener('click', retry, { once: true });
  }
}

/* ═══ DOM helpers ════════════════════════════════════════════════════════ */
export function h(tag, attrs = {}, ...children) {
  if (typeof tag === 'function') return tag(attrs, ...children);
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }

/* ═══ Icons (stroke set) ═════════════════════════════════════════════════ */
const PATHS = {
  home: 'M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z',
  layers: 'm12 2 9 5-9 5-9-5 9-5Z M3 12l9 5 9-5 M3 17l9 5 9-5',
  database: 'M12 3c4.97 0 9 1.34 9 3s-4.03 3-9 3-9-1.34-9-3 4.03-3 9-3Z M3 6v12c0 1.66 4.03 3 9 3s9-1.34 9-3V6 M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3',
  terminal: 'm4 17 6-6-6-6 M12 19h8',
  braces: 'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1 M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  archive: 'M21 8v13H3V8 M1 3h22v5H1z M10 12h4',
  plug: 'M12 22v-5 M9 8V2 M15 8V2 M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9l1-8Z',
  radio: 'M4.9 19.1C1 15.2 1 8.8 4.9 4.9 M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5 M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5 M19.1 4.9C23 8.8 23 15.2 19.1 19.1 M12 12h.01',
  file: 'M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z M14 2v6h6',
  code: 'm16 18 6-6-6-6 M8 6l-6 6 6 6',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  settings: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  plus: 'M12 5v14 M5 12h14',
  trash: 'M3 6h18 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  edit: 'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z',
  copy: 'M8 8h12v12H8z M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18 M6 6l12 12',
  play: 'm6 3 14 9-14 9V3Z',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36L21 8 M21 3v5h-5',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78Zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z M21 21l-4.3-4.3',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M12 6v6l4 2',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M2 12h20 M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z',
  webhook: 'M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17a4 4 0 0 1 6.53-3.1L11 9.5 M17 8a4 4 0 1 1 4 4c-.6 0-1.17-.13-1.68-.37L16 16',
  box: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z M3.3 7 12 12l8.7-5 M12 22V12',
  package2: 'M12 22V12 M2 7l10 5 10-5 M2 17l10 5 10-5 M2 7l10-5 10 5v10l-10 5L2 17Z',
  server: 'M4 2h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z M4 13h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z M7 5h.01 M7 16h.01',
  git: 'M6 3v12 M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M18 9a9 9 0 0 1-9 9',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z M22 6l-10 7L2 6',
  cpu: 'M6 4h12v16H6z M9 1v3 M15 1v3 M9 20v3 M15 20v3 M1 9h3 M1 15h3 M20 9h3 M20 15h3 M9 9h6v6H9z',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M12 16v-4 M12 8h.01',
  alert: 'M12 9v4 M12 17h.01 M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0Z',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  external: 'M15 3h6v6 M10 14 21 3 M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z M17 21v-8H7v8 M7 3v5h8',
  list: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  branch: 'M6 3v12 M18 9a3 3 0 1 0-3-3 M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M15 12a9 9 0 0 1-9 6',
  chart: 'M3 3v18h18 M7 15v-4 M12 15V7 M17 15v-6',
  table: 'M3 5h18v14H3z M3 10h18 M9 5v14 M15 5v14',
  chev: 'm6 9 6 6 6-6',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z M12 1v2 M12 21v2 M4.22 4.22l1.42 1.42 M18.36 18.36l1.42 1.42 M1 12h2 M21 12h2 M4.22 19.78l1.42-1.42 M18.36 5.64l1.42-1.42',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z',
};

export function icon(name, cls = 'icon') {
  const span = h('span', { class: `icon-wrap ${cls}`, style: { display: 'inline-flex' } });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  for (const d of (PATHS[name] || PATHS.info).split(' M')) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    // Only chunks AFTER a split need the M restored — the first chunk already
    // starts with M/m. Prepending unconditionally produced invalid "MM…" path
    // data: single-path icons vanished entirely and multi-path icons rendered
    // as half-drawn fragments.
    path.setAttribute('d', /^[Mm]/.test(d) ? d : 'M' + d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }
  span.append(svg);
  return span;
}

/* ═══ Toasts ═════════════════════════════════════════════════════════════ */
export function toast(message, { type = 'info', title = null, timeout = 4200 } = {}) {
  const root = qs('#toasts');
  const t = h('div', { class: `toast ${type}` },
    h('div', { style: { flex: '1' } },
      title ? h('div', { class: 'toast-title' }, title) : null,
      h('div', { class: 'toast-msg' }, message)),
    h('button', { class: 'toast-x', onclick: () => t.remove() }, '×'));
  root.append(t);
  if (timeout) setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, timeout);
  return t;
}
export const toastSuccess = (msg, title = 'Success') => toast(msg, { type: 'success', title });
export const toastError = (err, title = 'Error') => toast(typeof err === 'string' ? err : err.message, { type: 'error', title });

/* ═══ Modals ═════════════════════════════════════════════════════════════ */
export function modal({ title, body, footer, size = '' , onClose = null }) {
  const root = qs('#modal-root');
  const overlay = h('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', esc); onClose?.(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  const m = h('div', { class: `modal ${size}` },
    h('div', { class: 'modal-header' },
      h('div', { class: 'modal-title' }, title),
      h('button', { class: 'icon-btn', onclick: close }, icon('x'))),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-footer' }, footer) : null);
  overlay.append(m);
  root.append(overlay);
  return { close, overlay, modal: m };
}

export function confirmDialog({ title = 'Are you sure?', message = '', confirmText = 'Confirm', danger = false, requireText = null }) {
  return new Promise((resolve) => {
    let inputEl = null;
    const body = h('div', {},
      h('p', { style: { color: 'var(--text-muted)', fontSize: '13.5px' } }, message),
      requireText ? h('div', { class: 'field', style: { marginTop: '12px' } },
        h('label', {}, `Type "${requireText}" to confirm`),
        (inputEl = h('input', { class: 'input mono', placeholder: requireText }))) : null);
    const footer = h('div', {},
      h('button', { class: 'btn btn-ghost', onclick: () => { m.close(); resolve(false); } }, 'Cancel'),
      h('button', {
        class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
        onclick: () => {
          if (requireText && inputEl.value !== requireText) { toastError(`Type "${requireText}" to confirm`); return; }
          m.close(); resolve(true);
        },
      }, confirmText));
    const m = modal({ title, body, footer });
    inputEl?.focus();
  });
}

/* ═══ Form helpers ═══════════════════════════════════════════════════════ */
export function field(label, input, { hint = null, id = null } = {}) {
  if (id && !input.id) input.id = id;
  return h('div', { class: 'field' },
    h('label', { for: input.id || null }, label),
    input,
    hint ? h('div', { class: 'hint' }, hint) : null);
}

export function formRow(...fields) {
  return h('div', { class: 'form-row' }, ...fields);
}

export function checkboxRow(label, checked, onChange) {
  const cb = h('input', { type: 'checkbox' });
  cb.checked = !!checked;
  cb.addEventListener('change', () => onChange?.(cb.checked));
  return h('label', { class: 'checkbox-row' }, cb, label);
}

/* ═══ Table component ════════════════════════════════════════════════════ */
export function dataTable({ columns, rows, emptyTitle = 'Nothing here yet', emptyAction = null, onRowClick = null, footer = null, rowActions = null, searchable = false }) {
  const wrap = h('div', {});
  const toolbar = h('div', { class: 'table-toolbar' });
  const tableWrap = h('div', { class: 'table-wrap' });
  let searchTerm = '';
  let sortKey = null, sortDir = 1;

  const render = () => {
    clear(tableWrap);
    let data = [...(rows || [])];
    if (searchTerm) {
      const t = searchTerm.toLowerCase();
      data = data.filter((r) => columns.some((c) => String(r[c.key] ?? '').toLowerCase().includes(t)));
    }
    if (sortKey) {
      data.sort((a, b) => {
        const av = a[sortKey], bv = b[sortKey];
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * sortDir;
      });
    }
    if (!data.length) {
      tableWrap.append(emptyState({ title: emptyTitle, icon: 'box', action: emptyAction }));
      return;
    }
    const thead = h('thead', {}, h('tr', {}, ...columns.map((c) =>
      h('th', {
        class: c.sortable === false ? '' : 'sortable',
        onclick: () => { if (c.sortable === false) return; sortKey = sortKey === c.key ? sortKey : c.key; sortDir = sortKey === c.key ? -sortDir : 1; render(); },
      }, c.label, sortKey === c.key ? h('span', { class: 'sort-arrow' }, sortDir === 1 ? '↑' : '↓') : null))));
    const tbody = h('tbody', {}, ...data.map((row, i) =>
      h('tr', {
        class: onRowClick ? 'clickable' : '',
        onclick: onRowClick ? () => onRowClick(row, i) : null,
      },
      ...columns.map((c) => h('td', { class: c.className || '', title: c.title ? String(row[c.titleKey] ?? row[c.key] ?? '') : null },
        c.render ? c.render(row, i) : (row[c.key] ?? '')),
      ),
      rowActions ? h('td', { style: { width: '90px' } },
        h('div', { class: 'row-actions' }, ...rowActions(row))) : null)));
    tableWrap.append(h('table', { class: 'data' }, thead, tbody));
    if (footer) tableWrap.append(footer(data));
  };

  if (searchable) {
    const search = h('input', { class: 'input', placeholder: 'Filter…', oninput: (e) => { searchTerm = e.target.value; render(); } });
    toolbar.append(search);
  }
  wrap.append(toolbar, tableWrap);
  render();
  wrap.refresh = render;
  return wrap;
}

/* ═══ Small widgets ══════════════════════════════════════════════════════ */
export function badge(text, type = 'gray') {
  return h('span', { class: `badge badge-${type}`, 'data-env': text }, text);
}

export function emptyState({ title = 'Nothing here yet', sub = '', icon: ic = 'box', action = null }) {
  return h('div', { class: 'empty-state' },
    icon(ic),
    h('div', { class: 'empty-title' }, title),
    sub ? h('div', { class: 'empty-sub' }, sub) : null,
    action || null);
}

export function skeletons(count = 3, kind = 'line') {
  const wrap = h('div', { class: 'card pad-sm' });
  for (let i = 0; i < count; i++) wrap.append(h('div', { class: kind === 'line' ? 'skeleton skeleton-line' : 'skeleton skeleton-block', style: { width: `${90 - i * 12}%` } }));
  return wrap;
}

export function loadingBlock(text = 'Loading…') {
  return h('div', { class: 'loading-block' }, h('div', { class: 'spinner' }), text);
}

export function tabs({ items, onChange, active = null }) {
  const bar = h('div', { class: 'tabs' });
  items.forEach((item) => {
    const btn = h('button', { class: `tab ${active === item.id ? 'active' : ''}`, onclick: () => {
      qsa('.tab', bar).forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      onChange?.(item.id);
    } }, item.icon ? icon(item.icon) : null, item.label, item.closeable ? h('span', { class: 'close-x', onclick: (e) => { e.stopPropagation(); item.onClose?.(); } }, '×') : null);
    bar.append(btn);
  });
  bar.setActive = (id) => {
    qsa('.tab', bar).forEach((t) => t.classList.remove('active'));
    qsa('.tab', bar)[items.findIndex((i) => i.id === id)]?.classList.add('active');
  };
  return bar;
}

export function copyChip(text, display = null) {
  const chip = h('button', { class: 'copy-chip', title: 'Click to copy', onclick: async () => {
    try { await navigator.clipboard.writeText(text); toastSuccess('Copied to clipboard'); }
    catch { toastError('Clipboard unavailable'); }
  } }, icon('copy', 'icon icon-sm'), h('span', {}, display || text));
  return chip;
}

export function pagination({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return h('div', { class: 'table-footer' },
    h('span', {}, `${total} row${total === 1 ? '' : 's'} · page ${page}/${pages}`),
    h('div', { style: { display: 'flex', gap: '6px' } },
      h('button', { class: 'btn btn-ghost btn-sm', disabled: page <= 1, onclick: () => onPage(page - 1) }, '← Prev'),
      h('button', { class: 'btn btn-ghost btn-sm', disabled: page >= pages, onclick: () => onPage(page + 1) }, 'Next →')));
}

/* tooltips (data-tip attribute) */
export function initTooltips(root = document) {
  const tipRoot = qs('#tooltip-root');
  let current = null;
  root.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) return;
    current?.remove();
    current = h('div', { class: 'tooltip' }, t.getAttribute('data-tip'));
    tipRoot.append(current);
    const rect = t.getBoundingClientRect();
    const x = Math.min(rect.left + rect.width / 2, window.innerWidth - 150);
    current.style.left = `${Math.max(8, x - 70)}px`;
    current.style.top = `${rect.bottom + 7}px`;
  });
  root.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-tip]')) current?.remove();
  });
}

/* context menu */
export function contextMenu(items, x, y) {
  const root = qs('#context-menu-root');
  clear(root);
  const menu = h('div', { class: 'ctx-menu' },
    ...items.map((item) => item === '-' ? h('div', { class: 'menu-sep' }) :
      h('button', { class: `menu-item ${item.danger ? 'danger' : ''}`, onclick: () => { cleanup(); item.onClick?.(); } }, item.icon ? icon(item.icon) : null, item.label)));
  root.append(menu);
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 40 - items.length * 34)}px`;
  const cleanup = () => { clear(root); document.removeEventListener('click', onDoc); document.removeEventListener('scroll', cleanup, true); };
  const onDoc = (e) => { if (!menu.contains(e.target)) cleanup(); };
  setTimeout(() => document.addEventListener('click', onDoc), 10);
  document.addEventListener('scroll', cleanup, true);
}

/* dropdown helper */
export function dropdown(wrapEl) {
  const btn = qs('.crumb-btn, .avatar-btn', wrapEl);
  btn?.addEventListener('click', (e) => {
    e.stopPropagation();
    qsa('.dropdown.open').forEach((d) => { if (d !== wrapEl) d.classList.remove('open'); });
    wrapEl.classList.toggle('open');
  });
  document.addEventListener('click', () => wrapEl.classList.remove('open'));
}

/* ═══ Formatters ═════════════════════════════════════════════════════════ */
export function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
export function fmtNumber(n) {
  return Number(n ?? 0).toLocaleString();
}
export function fmtDate(ts, { relative = true } = {}) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (relative) {
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
  }
  return d.toLocaleString();
}
export function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/* ═══ JSON rendering ═════════════════════════════════════════════════════ */
export function jsonView(data) {
  const json = typeof data === 'string' ? JSON.stringify(safeParse(data) ?? data, null, 2) : JSON.stringify(data, null, 2);
  const pre = h('div', { class: 'json-view' });
  pre.innerHTML = highlightJson(json);
  return pre;
}
export function safeParse(text, dflt = null) {
  try { return JSON.parse(text); } catch { return dflt; }
}
export function highlightJson(json) {
  return json
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/("[^"]*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(\.\d+)?([eE][+-]?\d+)?)/g, (m) => {
      let cls = 'j-num';
      if (m.startsWith('"')) cls = m.endsWith(':') ? 'j-key' : 'j-str';
      else if (/true|false/.test(m)) cls = 'j-bool';
      else if (/null/.test(m)) cls = 'j-null';
      return `<span class="${cls}">${m}</span>`;
    });
}

/* SQL tokenizer for the editor highlight + autocomplete seeds */
const SQL_KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'INDEX', 'VIEW', 'ALTER', 'DROP', 'ADD', 'COLUMN', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'BETWEEN', 'LIKE', 'AS', 'DISTINCT', 'UNION', 'ALL', 'WITH', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION', 'EXISTS', 'DESC', 'ASC', 'PRAGMA', 'EXPLAIN', 'DEFAULT', 'UNIQUE', 'CHECK', 'CONSTRAINT', 'AUTOINCREMENT', 'IF'];
const SQL_FUNCS = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'LENGTH', 'UPPER', 'LOWER', 'ROUND', 'SUBSTR', 'DATE', 'DATETIME', 'STRFTIME', 'CAST', 'ABS', 'RANDOM', 'NOW', 'CONCAT'];

export function highlightSql(sql) {
  let out = '';
  let i = 0;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  while (i < sql.length) {
    const rest = sql.slice(i);
    // line comment
    const lc = /^--[^\n]*/.exec(rest);
    if (lc) { out += `<span class="tok-comment">${esc(lc[0])}</span>`; i += lc[0].length; continue; }
    const bc = /^\/\*[\s\S]*?\*\//.exec(rest);
    if (bc) { out += `<span class="tok-comment">${esc(bc[0])}</span>`; i += bc[0].length; continue; }
    // strings
    const str = /^'([^']|'')*'/.exec(rest);
    if (str) { out += `<span class="tok-string">${esc(str[0])}</span>`; i += str[0].length; continue; }
    // numbers
    const num = /^\d+(\.\d+)?/.exec(rest);
    if (num) { out += `<span class="tok-number">${esc(num[0])}</span>`; i += num[0].length; continue; }
    // identifiers / keywords
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (word) {
      const w = word[0];
      const upper = w.toUpperCase();
      if (SQL_KEYWORDS.includes(upper)) out += `<span class="tok-keyword">${esc(w)}</span>`;
      else if (SQL_FUNCS.includes(upper)) out += `<span class="tok-func">${esc(w)}</span>`;
      else out += esc(w);
      i += w.length;
      continue;
    }
    if (rest[0] === '"' || rest[0] === '`') {
      const q = rest[0];
      const end = rest.indexOf(q, 1);
      const seg = end === -1 ? rest : rest.slice(0, end + 1);
      out += `<span class="tok-string">${esc(seg)}</span>`;
      i += seg.length;
      continue;
    }
    out += esc(rest[0]);
    i++;
  }
  return out + '\n';
}

/* ═══ Mini sparkline (canvas, no deps) ═══════════════════════════════════ */
export function sparkline(values, { width = 220, height = 44, color = '#3bf95c', fill = true } = {}) {
  const canvas = h('canvas', { width, height, style: { maxWidth: '100%' } });
  requestAnimationFrame(() => {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    const data = values.length ? values : [0, 0];
    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const step = width / Math.max(data.length - 1, 1);
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = i * step;
      const y = height - 3 - ((v - min) / (max - min || 1)) * (height - 8);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();
    if (fill) {
      ctx.lineTo(width, height); ctx.lineTo(0, height); ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, color + '33');
      grad.addColorStop(1, color + '00');
      ctx.fillStyle = grad;
      ctx.fill();
    }
  });
  return canvas;
}

export function barChart(data, { width = 600, height = 160, color = '#3bf95c' } = {}) {
  const canvas = h('canvas', { width, height, style: { width: '100%', maxWidth: `${width}px` } });
  requestAnimationFrame(() => {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    const max = Math.max(...data.map((d) => d.value), 1);
    const bw = Math.min(38, (width - 20) / Math.max(data.length, 1) - 8);
    data.forEach((d, i) => {
      const x = 12 + i * ((width - 20) / Math.max(data.length, 1));
      const bh = (d.value / max) * (height - 36);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.roundRect(x, height - 22 - bh, bw, bh, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text-faint') || '#888';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(d.label, x + bw / 2, height - 8);
    });
  });
  return canvas;
}

/* ═══ requireProject helper ══════════════════════════════════════════════ */
export function requireProject(pageEl, featureName = 'This page') {
  if (!state.projectId || !state.project) {
    clear(pageEl).append(
      h('div', { class: 'page-header' }, h('div', {}, h('h2', { class: 'page-title' }, featureName))),
      emptyState({
        title: 'No project selected',
        sub: `${featureName} works inside a project. Create one or pick it from the project switcher in the top bar.`,
        icon: 'folder',
        action: h('button', { class: 'btn btn-primary', onclick: () => location.hash = '#/projects' }, icon('plus'), 'Go to Projects'),
      }));
    return false;
  }
  return true;
}

/* sync project from server into state (used by app.js) */
export async function refreshProject() {
  if (!state.projectId) { state.project = null; return null; }
  try {
    state.project = await get(`/api/admin/projects/${state.projectId}`);
  } catch {
    state.projectId = null; state.project = null;
    localStorage.removeItem('bloop.projectId');
  }
  return state.project;
}
