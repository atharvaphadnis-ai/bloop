// sidebar.js — grouped navigation with collapsible sections and badges.
import { h, clear, icon, qs, state } from './components.js';
import { go, currentRoute } from './router.js';

const NAV = [
  {
    label: null,
    items: [
      { id: 'overview', title: 'Overview', icon: 'home' },
      { id: 'projects', title: 'Projects', icon: 'layers' },
    ],
  },
  {
    label: 'Data',
    items: [
      { id: 'database', title: 'Database', icon: 'database' },
      { id: 'sql', title: 'SQL Editor', icon: 'terminal' },
      { id: 'nosql', title: 'NoSQL Explorer', icon: 'braces' },
    ],
  },
  {
    label: 'Services',
    items: [
      { id: 'authentication', title: 'Authentication', icon: 'shield' },
      { id: 'users', title: 'Users', icon: 'users' },
      { id: 'storage', title: 'Storage', icon: 'archive' },
      { id: 'api', title: 'API Explorer', icon: 'globe' },
      { id: 'graphql', title: 'GraphQL', icon: 'plug' },
      { id: 'realtime', title: 'Realtime', icon: 'radio' },
      { id: 'functions', title: 'Functions', icon: 'zap' },
      { id: 'webhooks', title: 'Webhooks', icon: 'webhook' },
    ],
  },
  {
    label: 'Management',
    items: [
      { id: 'analytics', title: 'Analytics', icon: 'chart' },
      { id: 'logs', title: 'Logs', icon: 'list' },
      { id: 'backups', title: 'Backups', icon: 'save' },
      { id: 'plugins', title: 'Plugins', icon: 'package2' },
      { id: 'settings', title: 'Settings', icon: 'settings' },
    ],
  },
];

export function renderSidebar() {
  const el = qs('#sidebar');
  if (!el) return;
  clear(el);
  const active = currentRoute();
  for (const group of NAV) {
    const groupEl = h('div', { class: 'nav-group' + (localStorage.getItem(`bloop.nav.${group.label || 'main'}.collapsed`) === '1' ? ' collapsed' : '') });
    if (group.label) {
      groupEl.append(h('button', { class: 'nav-toggle', onclick: (e) => {
        groupEl.classList.toggle('collapsed');
        localStorage.setItem(`bloop.nav.${group.label}.collapsed`, groupEl.classList.contains('collapsed') ? '1' : '0');
      } }, group.label, icon('chev')));
    }
    const items = h('div', { class: 'nav-items' });
    for (const item of group.items) {
      items.append(h('button', {
        class: `nav-item ${active === item.id ? 'active' : ''}`,
        onclick: () => { go(item.id); if (window.innerWidth <= 640) el.classList.remove('open'); },
        'data-tip': item.title,
      }, icon(item.icon), h('span', {}, item.title),
      item.badge ? h('span', { class: 'nav-badge' }, item.badge) : null));
    }
    groupEl.append(items);
    el.append(groupEl);
  }
}
