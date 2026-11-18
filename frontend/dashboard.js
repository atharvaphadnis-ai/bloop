// dashboard.js — Overview page: server status hero, project stats, environment
// chips, quick actions and recent activity — modeled on the reference UI.
import {
  h, clear, get, icon, state, sparkline, fmtBytes, fmtNumber, fmtDuration,
  emptyState, requireProject, badge, fmtDate,
} from './components.js';
import { register } from './router.js';
import { go } from './router.js';

register('overview', {
  title: 'Project Overview',
  group: null,
  async render(page) {
    let overview = null;
    try { overview = await get('/api/admin/observability/overview'); } catch { }
    let usage = null;
    if (state.projectId) {
      try { usage = await get(`/api/admin/projects/${state.projectId}/usage`); } catch { }
    }

    const health = overview?.health || { status: 'unknown', checks: [] };
    const dotClass = health.status === 'ok' ? '' : health.status === 'degraded' ? 'warn' : 'down';

    const hero = h('div', { class: 'hero-panel' },
      h('div', { style: { display: 'flex', gap: '18px', alignItems: 'center', flexWrap: 'wrap' } },
        h('div', { class: 'tile-icon green', style: { width: '52px', height: '52px' } }, icon('database', 'icon')),
        h('div', {},
          h('div', { class: 'tile-title', style: { fontSize: '15px' } }, state.project ? state.project.name : 'Bloop platform'),
          h('div', { class: 'tile-sub' }, `v${overview?.version || ''} · uptime ${fmtDuration((overview?.uptimeSec || 0) * 1000)} · region ${state.project?.region || 'local'}`))),
      h('div', { class: 'hero-status' },
        h('div', { class: 'head' }, h('span', { class: `dot ${dotClass}` }), 'Primary Database'),
        h('div', { class: 'tile-sub' }, `${overview?.counts?.projects ?? 0} projects · ${fmtBytes(overview?.counts?.storageBytes || 0)} stored`),
        h('div', { class: 'hero-stats' },
          h('span', {}, 'CPU ', h('b', {}, `${(overview?.memory ? ((overview.memory.rssBytes / (4 * 1024 ** 3)) * 100).toFixed(0) : 0)}%`)),
          h('span', {}, 'Req/24h ', h('b', {}, fmtNumber(overview?.requests24h || 0))),
          h('span', {}, 'Errors ', h('b', {}, fmtNumber(overview?.errors24h || 0))),
          h('span', {}, 'WS ', h('b', {}, fmtNumber(overview?.realtime?.connections || 0))))),
    );

    const stats = h('div', { class: 'grid grid-4', style: { marginTop: '14px' } },
      statCard(' Requests/min', `${overview?.rps ?? 0}`, 'activity', '', overview?.latency ? [overview.latency.p50, overview.latency.p95, overview.latency.p99] : []),
      statCard('p95 latency', `${overview?.latency?.p95 ?? 0}ms`, 'clock', ''),
      statCard('Error rate', `${overview?.errorRate ?? 0}%`, 'alert', ''),
      statCard('Dashboard users', fmtNumber(overview?.counts?.users ?? 0), 'users', ''),
    );

    const envRow = h('div', { style: { display: 'flex', gap: '9px', margin: '18px 0', flexWrap: 'wrap', alignItems: 'center' } },
      h('span', { class: 'micro' }, 'Environments'),
      ['dev', 'staging', 'prod'].map((e) => h('span', { class: 'env-chip' }, h('span', { class: 'dot', style: state.env === e ? '' : 'opacity:.35' }), e)),
      h('span', { class: 'micro', style: { marginLeft: 'auto' } }, 'Last backup'),
      h('span', { style: { fontSize: '13px' } }, overview?.lastBackup ? `${overview.lastBackup.name} · ${fmtDate(overview.lastBackup.created_at)}` : 'No backups yet'),
    );

    const grid = h('div', { class: 'grid grid-2' },
      tile('Database', state.project ? `${usage?.docCount ?? 0} documents · ${fmtBytes(usage?.dbSizeBytes || 0)}` : 'Select a project', 'database', 'sql', 'Open SQL Editor'),
      tile('Authentication', state.project ? `${usage?.userCount ?? 0} end users` : '—', 'shield', 'authentication', 'Configure auth'),
      tile('Storage', state.project ? fmtBytes(usage?.storageBytes || 0) : '—', 'archive', 'storage', 'Browse files'),
      tile('Functions', state.project ? `${usage?.functionRuns ?? 0} runs (30d)` : '—', 'zap', 'functions', 'Manage functions'),
      tile('Backups', overview?.counts?.backups ? `${overview.counts.backups} verified` : 'None yet', 'save', 'backups', 'Manage backups'),
      tile('Realtime', `${overview?.realtime?.connections ?? 0} live connections`, 'radio', 'realtime', 'Open Realtime'),
    );

    const healthCard = h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-header' }, h('div', {}, h('div', { class: 'card-title' }, 'Health checks'), h('div', { class: 'card-sub' }, 'Live probes from the health engine'))),
      (health.checks || []).length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Check'), h('th', {}, 'Status'), h('th', {}, 'Detail'), h('th', {}, 'Time'))),
        h('tbody', {}, ...health.checks.map((c) => h('tr', {},
          h('td', { class: 'cell-mono' }, c.name),
          h('td', {}, badge(c.status.toUpperCase(), c.status === 'ok' ? 'green' : c.status === 'degraded' ? 'badge-gray' : 'red')),
          h('td', { class: 'cell-dim' }, typeof c.detail === 'object' ? JSON.stringify(c.detail) : String(c.detail ?? '')),
          h('td', { class: 'cell-dim' }, `${c.durationMs}ms`)))))) : emptyState({ title: 'No health data', icon: 'activity' }),
    );

    clear(page).append(
      h('div', { class: 'page-header' },
        h('div', {},
          h('h2', { class: 'page-title' }, 'Project Overview'),
          h('p', { class: 'page-subtitle' }, 'Live status of your self-hosted Bloop instance and the selected project.')),
        h('div', { class: 'page-actions' },
          h('button', { class: 'btn btn-secondary', onclick: () => go('settings') }, icon('settings'), 'Settings'),
          h('button', { class: 'btn btn-primary', onclick: () => go('sql') }, icon('terminal'), 'Open SQL Editor'))),
      hero, stats, envRow, grid, healthCard);
  },
});

function statCard(label, value, ic, delta, spark = null) {
  return h('div', { class: 'card stat-card' },
    h('div', { class: 'stat-icon' }, icon(ic)),
    h('div', {},
      h('div', { class: 'micro' }, label.trim()),
      h('div', { class: 'stat-value' }, value),
      delta ? h('div', { class: 'stat-delta' }, delta) : null,
      spark && spark.length ? h('div', { style: { marginTop: '6px' } }, sparkline(spark, { width: 160, height: 30 })) : null));
}

function tile(title, sub, ic, route, actionLabel) {
  return h('div', { class: 'tile-card' },
    h('div', { class: 'tile-icon' }, icon(ic)),
    h('div', { style: { flex: '1', minWidth: '0' } },
      h('div', { class: 'tile-title' }, title),
      h('div', { class: 'tile-sub' }, sub),
      h('button', { class: 'btn btn-ghost btn-sm', style: { marginTop: '6px', padding: '2px 8px' }, onclick: () => go(route) }, actionLabel, icon('external'))));
}
