// analytics.js — two pages: Analytics (request/error/latency charts, usage by
// day, top paths) and Logs (searchable application log viewer with level
// filters, request log and audit trail).
import {
  h, clear, get, post, icon, state, toast, badge, emptyState, fmtNumber,
  fmtBytes, fmtDate, dataTable, sparkline, barChart, jsonView, safeParse,
  fmtDuration, copyChip,
} from './components.js';
import { register } from './router.js';

/* ═══ Analytics page ═════════════════════════════════════════════════════ */
register('analytics', {
  title: 'Analytics',
  async render(page) {
    const metrics = await get('/api/admin/metrics/summary');
    const usage = state.projectId
      ? await get(`/api/admin/projects/${state.projectId}/usage?days=30`).catch(() => null)
      : null;
    const requests = await get('/api/admin/requests?limit=300');
    const traces = await get('/api/admin/traces?limit=60');

    // aggregate requests by day + top paths
    const byDay = new Map();
    const byPath = new Map();
    const byStatus = new Map();
    for (const r of requests.requests || []) {
      const day = (r.ts || '').slice(0, 10);
      if (day) byDay.set(day, (byDay.get(day) || 0) + 1);
      const p = (r.path || '/').split('?')[0];
      byPath.set(p, (byPath.get(p) || 0) + 1);
      const cls = `${Math.floor((r.status || 0) / 100)}xx`;
      byStatus.set(cls, (byStatus.get(cls) || 0) + 1);
    }
    const chartData = [...byDay.entries()].sort().slice(-14).map(([label, value]) => ({ label: label.slice(5), value }));
    const topPaths = [...byPath.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

    page.append(
      h('div', { class: 'page-header' },
        h('div', {},
          h('h2', { class: 'page-title' }, 'Analytics'),
          h('p', { class: 'page-subtitle' }, 'Live platform metrics — requests, latency percentiles, error rates and slow traces. Prometheus format at /api/admin/metrics/prometheus.')),
        h('div', { class: 'page-actions' },
          h('button', { class: 'btn btn-ghost', onclick: () => location.hash = '#/logs' }, icon('list'), 'Logs'))),
      h('div', { class: 'grid grid-4' },
        stat('Requests / sec', fmtNumber(metrics.rps), 'activity'),
        stat('p50 latency', `${metrics.latencyMs?.p50 ?? 0}ms`, 'clock'),
        stat('p95 latency', `${metrics.latencyMs?.p95 ?? 0}ms`, 'clock'),
        stat('Errors', fmtNumber(metrics.errors), 'alert')),
      h('div', { class: 'card', style: { marginTop: '14px' } },
        h('div', { class: 'card-header' }, h('div', {},
          h('div', { class: 'card-title' }, 'Requests per day (last 14 days)'),
          h('div', { class: 'card-sub' }, 'from the request log'))),
        chartData.length ? barChart(chartData, { width: 720, height: 170 }) : emptyState({ title: 'No request data yet', sub: 'Make a few API calls and come back.', icon: 'chart' })),
      h('div', { class: 'grid grid-2', style: { marginTop: '14px' } },
        h('div', { class: 'card pad-sm' },
          h('div', { class: 'micro', style: { marginBottom: '8px' } }, 'Top paths'),
          topPaths.length ? h('div', {}, ...topPaths.map(([p, n]) => h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '5px 0' } },
            h('span', { class: 'cell-mono', style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis' } }, p),
            h('div', { class: 'progress-bar', style: { width: '120px' } }, h('div', { style: { width: `${(n / topPaths[0][1]) * 100}%` } })),
            h('span', { class: 'cell-dim' }, fmtNumber(n))))) : h('div', { class: 'cell-dim' }, '—')),
        h('div', { class: 'card pad-sm' },
          h('div', { class: 'micro', style: { marginBottom: '8px' } }, 'Status classes'),
          h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
            ...[...byStatus.entries()].map(([cls, n]) => h('span', { class: 'env-chip' },
              h('span', { class: 'dot', style: { background: cls === '2xx' ? 'var(--accent)' : cls === '4xx' ? 'var(--warn)' : cls === '5xx' ? 'var(--danger)' : 'var(--text-faint)' } }),
              `${cls}: ${fmtNumber(n)}`))))),
      h('div', { class: 'card', style: { marginTop: '14px' } },
        h('div', { class: 'card-header' }, h('div', {},
          h('div', { class: 'card-title' }, 'Recent traces'),
          h('div', { class: 'card-sub' }, `${metrics.eventLoopLagMs}ms event-loop lag · RSS ${fmtBytes(metrics.memory?.rssBytes || 0)}`))),
        traces.traces?.length ? dataTable({
          columns: [
            { key: 'method', label: 'Method' },
            { key: 'path', label: 'Path', className: 'cell-mono' },
            { key: 'status', label: 'Status', render: (t) => badge(String(t.status), t.status < 400 ? 'green' : t.status < 500 ? 'badge-gray' : 'red') },
            { key: 'durationMs', label: 'Duration', render: (t) => fmtDuration(t.durationMs) },
            { key: 'spans', label: 'Spans', render: (t) => String(t.spans?.length || 0) },
            { key: 'id', label: 'Trace', className: 'cell-dim cell-mono' },
          ],
          rows: traces.traces,
        }) : emptyState({ title: 'No traces recorded yet', icon: 'activity' })),
      state.projectId && usage ? h('div', { class: 'card', style: { marginTop: '14px' } },
        h('div', { class: 'card-header' }, h('div', { class: 'card-title' }, `Project usage — last 30 days`)),
        h('div', { class: 'kv-list' },
          h('dt', {}, 'Requests'), h('dd', {}, fmtNumber(usage.requests)),
          h('dt', {}, 'Errors'), h('dd', {}, `${fmtNumber(usage.errors)} (${usage.errorRate}%)`),
          h('dt', {}, 'Storage'), h('dd', {}, `${fmtBytes(usage.storageBytes)} · ${fmtNumber(usage.objectCount)} objects`),
          h('dt', {}, 'Function runs'), h('dd', {}, fmtNumber(usage.functionRuns)),
          h('dt', {}, 'End users'), h('dd', {}, fmtNumber(usage.userCount)),
          h('dt', {}, 'Documents'), h('dd', {}, fmtNumber(usage.docCount)))) : null);

    function stat(label, value, ic) {
      return h('div', { class: 'card stat-card' },
        h('div', { class: 'stat-icon' }, icon(ic)),
        h('div', {}, h('div', { class: 'micro' }, label), h('div', { class: 'stat-value' }, value)));
    }
  },
});

/* ═══ Logs page ══════════════════════════════════════════════════════════ */
register('logs', {
  title: 'Logs',
  projectScoped: false,
  async render(page) {
    const levelSel = h('select', { class: 'input', style: { width: '110px' } },
      h('option', { value: '' }, 'all levels'),
      ...['error', 'warn', 'info', 'http', 'debug'].map((l) => h('option', { value: l }, l)));
    const search = h('input', { class: 'input', placeholder: 'Search message content…', style: { width: '220px' } });
    const tabBar = h('div', { class: 'tabs' },
      tabBtn('Application', true), tabBtn('Requests'), tabBtn('Audit trail'));
    const container = h('div', {});
    tabBar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      [...tabBar.children].forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      renderTab(btn.dataset.tab);
    });

    async function renderTab(name) {
      clear(container).append(h('div', { class: 'loading-block' }, h('div', { class: 'spinner' }), 'Loading…'));
      try {
        if (name === 'application') {
          const { logs } = await get(`/api/admin/logs?limit=300&level=${levelSel.value}&contains=${encodeURIComponent(search.value || '')}`);
          clear(container);
          if (!logs.length) return container.append(emptyState({ title: 'No log entries match', icon: 'list' }));
          container.append(dataTable({
            columns: [
              { key: 'ts', label: 'Time', render: (l) => h('span', { class: 'cell-dim' }, fmtDate(l.ts)) },
              { key: 'level', label: 'Level', render: (l) => badge(l.level.toUpperCase(), l.level === 'error' ? 'red' : l.level === 'warn' ? 'badge-gray' : l.level === 'http' ? 'outline' : 'green') },
              { key: 'source', label: 'Source', className: 'cell-dim' },
              { key: 'message', label: 'Message', render: (l) => h('span', { style: { whiteSpace: 'normal', wordBreak: 'break-word' } }, l.message) },
              { key: 'meta_json', label: '', render: (l) => l.meta_json ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => modal2('Log metadata', jsonView(safeParse(l.meta_json, l.meta_json))) }, 'meta') : null },
            ],
            rows: logs,
          }));
        } else if (name === 'requests') {
          const { requests } = await get(`/api/admin/requests?limit=300`);
          clear(container);
          if (!requests.length) return container.append(emptyState({ title: 'No requests logged yet', icon: 'globe' }));
          container.append(dataTable({
            columns: [
              { key: 'ts', label: 'Time', render: (r) => h('span', { class: 'cell-dim' }, fmtDate(r.ts)) },
              { key: 'method', label: 'Method' },
              { key: 'path', label: 'Path', className: 'cell-mono' },
              { key: 'status', label: 'Status', render: (r) => badge(String(r.status), r.status < 400 ? 'green' : r.status < 500 ? 'badge-gray' : 'red') },
              { key: 'duration_ms', label: 'Duration', render: (r) => `${r.duration_ms}ms` },
              { key: 'ip', label: 'IP', className: 'cell-dim' },
              { key: 'request_id', label: 'Request ID', className: 'cell-dim cell-mono' },
            ],
            rows: requests,
          }));
        } else {
          const audit = await get('/api/admin/audit-logs?limit=300');
          clear(container);
          container.append(
            h('div', { class: 'table-toolbar' },
              h('span', { class: 'cell-dim', style: { fontSize: '12.5px' } }, `${audit.total} audit entries — admin actions, auth events, backups, restores`),
              h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
                const res = await fetch('/api/admin/audit-logs?format=csv&limit=1000', { headers: { Authorization: `Bearer ${localStorage.getItem('bloop.adminToken')}` } });
                const blob = await res.blob();
                const a = h('a', { href: URL.createObjectURL(blob), download: 'bloop-audit.csv' }); a.click();
              } }, icon('download'), 'Export CSV')),
            audit.entries.length ? dataTable({
              columns: [
                { key: 'created_at', label: 'Time', render: (a) => h('span', { class: 'cell-dim' }, fmtDate(a.created_at)) },
                { key: 'actor', label: 'Actor' },
                { key: 'action', label: 'Action', className: 'cell-mono' },
                { key: 'target', label: 'Target', className: 'cell-dim' },
                { key: 'ip', label: 'IP', className: 'cell-dim' },
              ],
              rows: audit.entries,
            }) : emptyState({ title: 'No audit entries yet', icon: 'shield' }));
        }
      } catch (e) {
        clear(container);
        container.append(h('div', { class: 'error-box' }, e.message));
      }
    }

    function tabBtn(label, active) {
      return h('button', { class: `tab ${active ? 'active' : ''}`, 'data-tab': label }, label);
    }
    function modal2(title, body) {
      import('./components.js').then(({ modal }) => modal({ title, size: 'modal-lg', body }));
    }

    page.append(
      h('div', { class: 'page-header' },
        h('div', {},
          h('h2', { class: 'page-title' }, 'Logs'),
          h('p', { class: 'page-subtitle' }, 'Structured JSON logs with retention pruning: application logs, HTTP request logs and the immutable audit trail.')),
        h('div', { class: 'page-actions' },
          levelSel, search,
          h('button', { class: 'btn btn-secondary btn-sm', onclick: () => renderTab('application') }, icon('search'), 'Search'))),
      tabBar, container);
    renderTab('application');
  },
});
