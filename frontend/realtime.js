// realtime.js — Realtime page: live WebSocket tester against the platform's
// own /realtime/v1 endpoint — subscribe to DB channels with filters, join
// presence channels, broadcast messages, inspect the raw event stream.
import {
  h, clear, get, post, icon, state, toast, toastSuccess, toastError, badge,
  requireProject, emptyState, copyChip,
} from './components.js';
import { register } from './router.js';

function fmtTime2(d) {
  return d.toTimeString().slice(0, 8);
}

register('realtime', {
  title: 'Realtime',
  async render(page) {
    if (!requireProject(page, 'Realtime')) return;
    clear(page);
    const stats = await get('/api/admin/realtime/stats');

    const statusDot = h('span', { class: 'dot', style: 'width:8px;height:8px;border-radius:50%;background:var(--danger);display:inline-block' });
    const statusText = h('span', {}, 'Disconnected');
    const log = h('div', { class: 'json-view', style: { maxHeight: '420px', fontFamily: 'var(--font-mono)', fontSize: '12px' } }, 'Events appear here…');
    let ws = null;

    const urlInput = h('input', { class: 'input mono', value: `${location.origin.replace(/^http/, 'ws')}/realtime/v1`, style: { flex: '1' } });
    const channelInput = h('input', { class: 'input mono', value: `project:${state.projectId}:db:`, placeholder: 'project:<projectId>:db:<table>', style: { flex: '1' } });
    const filterInput = h('input', { class: 'input mono', placeholder: '{"published": true} (optional)', style: { flex: '1' } });
    const broadcastInput = h('input', { class: 'input', placeholder: 'Message to broadcast on the channel…', style: { flex: '1' } });
    const presenceChannel = h('input', { class: 'input mono', value: `project:${state.projectId}:presence:dashboard`, style: { flex: '1' } });

    function setStatus(open) {
      statusDot.style.background = open ? 'var(--accent)' : 'var(--danger)';
      statusDot.style.boxShadow = open ? '0 0 8px var(--accent)' : 'none';
      statusText.textContent = open ? 'Connected' : 'Disconnected';
    }
    function appendLog(obj) {
      if (log.textContent.startsWith('Events appear')) clear(log);
      const line = h('div', { style: { padding: '3px 0', borderBottom: '1px solid var(--border)', wordBreak: 'break-all' } },
        h('span', { style: { color: 'var(--text-faint)' } }, fmtTime2(new Date())),
        ' ', JSON.stringify(obj));
      log.prepend(line);
      while (log.children.length > 200) log.lastChild.remove();
    }

    function connect() {
      try {
        ws = new WebSocket(urlInput.value);
        ws.addEventListener('open', () => {
          setStatus(true);
          appendLog({ type: 'ok', message: 'connected' });
          toastSuccess('WebSocket connected');
          // out-of-the-box sync: watch the whole selected project immediately
          try {
            ws.send(JSON.stringify({ op: 'subscribe', channel: `project:${state.projectId}` }));
            appendLog({ type: 'ok', message: `auto-subscribed → project:${state.projectId} (all tables)` });
          } catch { /* socket closed */ }
        });
        ws.addEventListener('message', (e) => {
          const m = JSON.parse(e.data);
          appendLog(m.type === 'data' ? { event: `${m.op} → ${m.table}`, rows: m.rows ?? null, ts: m.ts } : m);
        });
        ws.addEventListener('close', () => { setStatus(false); appendLog({ type: 'closed' }); });
        ws.addEventListener('error', () => appendLog({ type: 'error', message: 'connection error' }));
      } catch (e) { toastError(e); }
    }
    function send(obj) {
      if (!ws || ws.readyState !== 1) return toastError('Connect first');
      ws.send(JSON.stringify(obj));
      appendLog({ ...obj, __outgoing: true });
    }

    const connectBtn = h('button', { class: 'btn btn-primary btn-sm', onclick: () => { ws ? (ws.close(), ws = null) : connect(); } }, 'Connect / Disconnect');
    const subBtn = h('button', { class: 'btn btn-secondary btn-sm', onclick: () => {
      const filter = filterInput.value.trim();
      send({ op: 'subscribe', channel: channelInput.value, ...(filter ? { filter: JSON.parse(filter) } : {}) });
    } }, icon('radio'), 'Subscribe');
    const broadcastBtn = h('button', { class: 'btn btn-secondary btn-sm', onclick: () => {
      send({ op: 'broadcast', channel: channelInput.value, event: 'message', payload: { text: broadcastInput.value, from: 'dashboard' } });
    } }, icon('zap'), 'Broadcast');
    const presenceBtn = h('button', { class: 'btn btn-secondary btn-sm', onclick: () => {
      send({ op: 'subscribe', channel: presenceChannel.value });
      setTimeout(() => send({ op: 'presence', channel: presenceChannel.value, state: { user: state.admin?.email, at: Date.now() } }), 300);
    } }, icon('users'), 'Join presence');
    const pingBtn = h('button', { class: 'btn btn-ghost btn-sm', onclick: () => send({ op: 'ping' }) }, 'Ping');

    page.append(
      h('div', { class: 'page-header' },
        h('div', {},
          h('h2', { class: 'page-title' }, 'Realtime'),
          h('p', { class: 'page-subtitle' }, 'WebSocket engine implemented on native Node sockets: database change subscriptions (insert/update/delete with filters), presence, broadcast, private channels, heartbeats and reconnection.')),
        h('div', { class: 'page-actions' },
          h('span', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' } }, statusDot, statusText))),
      h('div', { class: 'grid grid-3' },
        stat('Live connections', stats.connections),
        stat('Channels', stats.channels),
        stat('DB subscriptions', stats.dbSubscriptions)),
      h('div', { class: 'card', style: { marginTop: '14px' } },
        h('div', { class: 'card-header' }, h('div', { class: 'card-title' }, 'Live tester'), connectBtn),
        h('div', { class: 'field' }, h('label', {}, 'Endpoint'), h('div', { class: 'input-with-btn' }, urlInput, copyChip(urlInput.value, 'copy'))),
        h('div', { class: 'field' }, h('label', {}, 'Channel (db / broadcast)'), h('div', { class: 'input-with-btn' }, channelInput, subBtn, pingBtn)),
        h('div', { class: 'field' }, h('label', {}, 'Event filter (JSON, equality on new values)'), h('div', { class: 'input-with-btn' }, filterInput)),
        h('div', { class: 'field' }, h('label', {}, 'Broadcast'), h('div', { class: 'input-with-btn' }, broadcastInput, broadcastBtn)),
        h('div', { class: 'field' }, h('label', {}, 'Presence channel'), h('div', { class: 'input-with-btn' }, presenceChannel, presenceBtn))),
      h('div', { class: 'card', style: { marginTop: '14px' } },
        h('div', { class: 'card-header' }, h('div', { class: 'card-title' }, 'Event stream'),
          h('span', { class: 'cell-dim', style: { fontSize: '12px' } }, 'outgoing messages marked __outgoing')),
        log),
      h('div', { class: 'callout', style: { marginTop: '12px' } },
        'Client usage: open a WebSocket to ', copyChip(`${location.origin.replace(/^http/, 'ws')}/realtime/v1`, '/realtime/v1'),
        ' and send {"op":"subscribe","channel":"project:<projectId>:db:<table>"}. Generated SDKs wrap this via client.realtime().'));

    // connect as soon as the page opens — live feed starts with no clicks
    if (state.projectId) {
      channelInput.value = `project:${state.projectId}`;
      connect();
    }

    function stat(label, value) {
      return h('div', { class: 'card stat-card' },
        h('div', { class: 'stat-icon' }, icon('radio')),
        h('div', {}, h('div', { class: 'micro' }, label), h('div', { class: 'stat-value' }, String(value))));
    }
  },
});
