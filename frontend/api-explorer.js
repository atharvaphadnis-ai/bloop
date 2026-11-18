// api-explorer.js — two pages: API Explorer (live endpoint testing against
// real project routes, OpenAPI docs, API key management) and GraphQL
// (schema docs, query editor with variables, real execution).
import {
  h, clear, get, post, del, icon, state, toast, toastSuccess, toastError,
  modal, field, emptyState, requireProject, badge, fmtDate, dataTable,
  confirmDialog, copyChip, jsonView, safeParse, highlightSql, fmtBytes,
} from './components.js';
import { register } from './router.js';

/* ═══ API Explorer ═══════════════════════════════════════════════════════ */
register('api', {
  title: 'API Explorer',
  async render(page) {
    if (!requireProject(page, 'API Explorer')) return;
    clear(page);
    const { keys } = await get(`/api/admin/projects/${state.projectId}/keys`);
    let openapi = null;
    let paths = [];
    try {
      openapi = await get(`/api/v1/${state.projectId}/openapi.json`);
      paths = Object.keys(openapi.paths || {});
    } catch { }

    const keyTable = h('div', { class: 'card', style: { marginBottom: '14px' } },
      h('div', { class: 'card-header' },
        h('div', {},
          h('div', { class: 'card-title' }, 'API keys'),
          h('div', { class: 'card-sub' }, 'Keys are hashed at rest (SHA-256) — shown once at creation. Bootstrap keys are available via Connect.')),
        h('button', { class: 'btn btn-primary btn-sm', onclick: () => showCreateKeyModal(refreshKeys) }, icon('plus'), 'New key')),
      h('div', { id: 'keys-table' }));
    async function refreshKeys() {
      const { keys } = await get(`/api/admin/projects/${state.projectId}/keys`);
      const wrap = qs2('#keys-table', keyTable);
      clear(wrap);
      if (!keys.length) { wrap.append(emptyState({ title: 'No custom keys', icon: 'key' })); return; }
      wrap.append(dataTable({
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'key_type', label: 'Type', render: (k) => badge(k.key_type.toUpperCase(), k.key_type === 'service' ? 'red' : k.key_type === 'anon' ? 'green' : 'outline') },
          { key: 'masked', label: 'Key', className: 'cell-mono' },
          { key: 'scopes_json', label: 'Scopes', render: (k) => h('span', { class: 'cell-dim mono', style: { fontSize: '11px' } }, k.scopes_json) },
          { key: 'revoked', label: 'Status', render: (k) => badge(k.revoked ? 'REVOKED' : 'ACTIVE', k.revoked ? 'gray' : 'green') },
          { key: 'last_used_at', label: 'Last used', render: (k) => h('span', { class: 'cell-dim' }, fmtDate(k.last_used_at)) },
        ],
        rows: keys,
        rowActions: (k) => k.revoked ? [] : [h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
          const ok = await confirmDialog({ title: `Revoke key “${k.name}”?`, message: 'Clients using it will get 401 immediately.', confirmText: 'Revoke', danger: true });
          if (!ok) return;
          await post(`/api/admin/projects/${state.projectId}/keys/${k.id}/revoke`);
          toastSuccess('Key revoked'); refreshKeys();
        } }, icon('x'))],
      }));
    }
    refreshKeys();

    /* request builder */
    const methodSel = h('select', { class: 'input', style: { width: '110px' } },
      ...['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].map((m) => h('option', { value: m }, m)));
    const pathInput = h('input', { class: 'input mono', value: `/api/v1/${state.projectId}/db/`, style: { flex: '1' }, placeholder: '/api/v1/<projectId>/db/<table>' });
    const keySel = h('select', { class: 'input', style: { width: '150px' }, 'data-tip': 'Credential to send' });
    const bodyInput = h('textarea', { class: 'input mono', placeholder: '{"title": "hello"}', style: { minHeight: '70px' } });
    const responseArea = h('div', { class: 'json-view', style: { maxHeight: '380px', minHeight: '80px' } }, 'Response appears here…');
    const statusLine = h('div', { class: 'results-meta' });

    async function loadKeysForPicker() {
      const { keys: allKeys } = await get(`/api/admin/projects/${state.projectId}/keys`);
      clear(keySel);
      keySel.append(h('option', { value: 'anon' }, 'anon key (bootstrap)'));
      keySel.append(h('option', { value: 'service' }, 'service_role key (bootstrap)'));
      for (const k of allKeys.filter((k) => !k.revoked && k.key_type === 'custom')) {
        keySel.append(h('option', { value: k.id }, `custom: ${k.name}`));
      }
    }
    loadKeysForPicker();

    async function send() {
      clear(statusLine);
      try {
        const path = pathInput.value;
        const url = path.startsWith('http') ? path : location.origin + path;
        const headers = {};
        const mode = keySel.value;
        if (mode !== 'none') {
          const revealed = await get(`/api/admin/projects/${state.projectId}/keys/reveal`);
          headers.Authorization = `Bearer ${mode === 'anon' ? revealed.anon : mode === 'service' ? revealed.service : (await get(`/api/admin/projects/${state.projectId}/keys`)).keys.find((k) => k.id === mode)?.id || ''}`;
          if (mode !== 'anon' && mode !== 'service') {
            toastError('Custom key plaintext is not stored (hashed only) — use the anon/service bootstrap keys here');
            return;
          }
        }
        const method = methodSel.value;
        const opts = { method, headers };
        if (!['GET', 'DELETE'].includes(method) && bodyInput.value.trim()) {
          opts.headers['Content-Type'] = 'application/json';
          const parsed = safeParse(bodyInput.value, undefined);
          if (parsed === undefined) throw new Error('Request body is not valid JSON');
          opts.body = JSON.stringify(parsed);
        }
        const t0 = performance.now();
        const res = await fetch(url, opts);
        const ms = Math.round(performance.now() - t0);
        const text = await res.text();
        let display = text;
        try { display = JSON.stringify(JSON.parse(text), null, 2); } catch { }
        responseArea.textContent = display.slice(0, 20000);
        statusLine.append(
          h('span', { class: res.ok ? 'ok' : 'err' }, `${method} ${path} → ${res.status} ${res.statusText}`),
          h('span', { class: 'cell-dim' }, `${ms}ms · ${fmtBytes(text.length)}`));
      } catch (e) {
        statusLine.append(h('span', { class: 'err' }, e.message));
      }
    }

    const explorerCard = h('div', { class: 'card' },
      h('div', { class: 'card-header' }, h('div', {},
        h('div', { class: 'card-title' }, 'Request builder'),
        h('div', { class: 'card-sub' }, 'Requests hit your real project endpoints — same auth, rate limits and row-level security as production clients.'))),
      h('div', { class: 'input-with-btn', style: { flexWrap: 'wrap' } }, methodSel, pathInput, keySel,
        h('button', { class: 'btn btn-primary', onclick: send }, icon('play'), 'Send')),
      h('div', { class: 'field', style: { marginTop: '10px' } }, h('label', {}, 'Body (JSON)'), bodyInput),
      statusLine, responseArea);

    const docsCard = h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-header' },
        h('div', {}, h('div', { class: 'card-title' }, 'OpenAPI 3.0 document'),
          h('div', { class: 'card-sub' }, 'Generated live from your schema — filter syntax: column.operator=value (eq, neq, gt, gte, lt, lte, like, in, is)')),
        h('button', { class: 'btn btn-secondary btn-sm', onclick: () => window.open(`/api/v1/${state.projectId}/openapi.json`, '_blank') }, icon('external'), 'Raw JSON')),
      paths.length ? h('div', { class: 'table-wrap', style: { maxHeight: '320px', overflow: 'auto' } },
        h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Path'), h('th', {}, 'Operations'))),
          h('tbody', {}, ...paths.map((p) => h('tr', { style: { cursor: 'pointer' }, onclick: () => {
            pathInput.value = p.startsWith('/') ? `/api/v1/${state.projectId}${p === '/db' ? '' : ''}`.replace(/\/db$/, '') : p;
            if (p.startsWith('/')) pathInput.value = `/api/v1/${state.projectId}${p}`;
            methodSel.value = 'GET';
          } },
          h('td', { class: 'cell-mono' }, p),
          h('td', { class: 'cell-dim' }, Object.keys(openapi.paths[p]).join(', ').toUpperCase())))))) : emptyState({ title: 'No schema yet', icon: 'globe' }));

    page.append(
      h('div', { class: 'page-header' },
        h('div', {},
          h('h2', { class: 'page-title' }, 'API Explorer'),
          h('p', { class: 'page-subtitle' }, 'Test the auto-generated REST API with real credentials. Versioned at /api/v1 · OpenAPI 3.0 at /api/v1/<projectId>/openapi.json.')),
        h('div', { class: 'page-actions' },
          h('button', { class: 'btn btn-secondary', onclick: () => location.hash = '#/graphql' }, icon('plug'), 'GraphQL'),
          h('button', { class: 'btn btn-ghost', onclick: () => showCurlModal() }, icon('terminal'), 'cURL examples'))),
      explorerCard, keyTable, docsCard);

    function showCreateKeyModal(refresh) {
      const name = h('input', { class: 'input', placeholder: 'mobile-app' });
      const type = h('select', { class: 'input' }, h('option', { value: 'custom' }, 'custom'), h('option', { value: 'anon' }, 'anon (read-only)'), h('option', { value: 'service' }, 'service_role (bypasses RLS!)'));
      const scopes = h('input', { class: 'input mono', value: '[{"domain": "db", "actions": ["read", "write"]}]' });
      const m = modal({
        title: 'Create API key',
        size: 'modal-lg',
        body: h('div', {},
          formRow(field('Name', name), field('Type', type)),
          field('Scopes (JSON)', scopes, { hint: 'domain: db | auth | storage | functions | realtime | * — actions: read | write | invoke | *' })),
        footer: h('button', { class: 'btn btn-primary', onclick: async () => {
          const scopeObj = safeParse(scopes.value, null);
          if (scopeObj === null) return toastError('Scopes must be valid JSON');
          try {
            const key = await post(`/api/admin/projects/${state.projectId}/keys`, { name: name.value, type: type.value, scopes: scopeObj });
            m.close();
            modal({ title: 'Key created — copy it now', size: 'modal-lg', body: h('div', {},
              h('div', { class: 'callout warn', style: { marginBottom: '12px' } }, 'This key is shown once and stored only as a SHA-256 hash.'),
              h('div', { class: 'field' }, h('label', {}, key.type + ' key'), copyChip(key.key))) });
            refresh?.();
          } catch (e) { toastError(e); }
        } }, 'Create key'),
      });
    }

    function showCurlModal() {
      const examples = [
        ['List rows with filters', `curl "${location.origin}/api/v1/${state.projectId}/db/posts?status=eq.published&order=created_at.desc&limit=10" \\
  -H "Authorization: Bearer <anon-key>"`],
        ['Insert (service key)', `curl -X POST "${location.origin}/api/v1/${state.projectId}/db/posts" \\
  -H "Authorization: Bearer <service-key>" -H "Content-Type: application/json" \\
  -d '{"title": "Hello", "published": false}'`],
        ['Register a user', `curl -X POST "${location.origin}/api/v1/${state.projectId}/auth/register" \\
  -H "Content-Type: application/json" \\
  -d '{"email": "user@example.com", "password": "supersecret1"}'`],
        ['Upload a file', `curl -X POST "${location.origin}/api/v1/${state.projectId}/storage/uploads" \\
  -H "Authorization: Bearer <anon-key>" \\
  -F "file=@photo.jpg"`],
        ['GraphQL', `curl -X POST "${location.origin}/api/v1/${state.projectId}/graphql" \\
  -H "Authorization: Bearer <anon-key>" -H "Content-Type: application/json" \\
  -d '{"query": "{ posts(limit: 5) { id title } }"}'`],
      ];
      const items = examples.map(([title, cmd]) => {
        const label = h('label', {}, title);
        const pre = h('pre', { class: 'json-view', style: { maxHeight: '130px' } }, cmd);
        return h('div', { class: 'field' }, label, pre);
      });
      modal({ title: 'cURL examples', size: 'modal-lg', body: h('div', {}, ...items) });
    }
  },
});



function qs2(sel, root) { return root.querySelector(sel); }

/* ═══ GraphQL page ═══════════════════════════════════════════════════════ */
register('graphql', {
  title: 'GraphQL',
  async render(page) {
    if (!requireProject(page, 'GraphQL')) return;
    clear(page);
    const endpoint = `/api/v1/${state.projectId}/graphql`;
    const query = h('textarea', { class: 'editor-textarea', spellcheck: 'false', style: { minHeight: '220px' } });
    query.value = `# Auto-generated from your schema · Ctrl+Enter to run
query {
  __schema {
    queryType { name }
    types { name kind }
  }
}`;
    const highlight = h('pre', { class: 'editor-highlight' });
    const varsInput = h('textarea', { class: 'input mono', placeholder: '{ "limit": 5 }', style: { minHeight: '52px' } });
    const responseArea = h('div', { class: 'json-view', style: { maxHeight: '420px' } }, 'Response…');
    const metaLine = h('div', { class: 'results-meta' });

    function syncHighlight() {
      highlight.innerHTML = highlightSql(query.value) + '\n';
    }
    query.addEventListener('input', syncHighlight);
    syncHighlight();
    query.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    });

    const keySel = h('select', { class: 'input', style: { width: '150px' } },
      h('option', { value: 'anon' }, 'anon key'), h('option', { value: 'service' }, 'service key'));

    async function run() {
      clear(metaLine);
      try {
        const revealed = await get(`/api/admin/projects/${state.projectId}/keys/reveal`);
        const variables = safeParse(varsInput.value || '{}', null);
        if (variables === null) throw new Error('Variables are not valid JSON');
        const t0 = performance.now();
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keySel.value === 'anon' ? revealed.anon : revealed.service}` },
          body: JSON.stringify({ query: query.value, variables }),
        });
        const ms = Math.round(performance.now() - t0);
        const data = await res.json();
        responseArea.innerHTML = '';
        responseArea.append(jsonView(data));
        metaLine.append(
          h('span', { class: data.errors ? 'err' : 'ok' }, data.errors ? `${data.errors.length} error(s)` : 'OK'),
          h('span', { class: 'cell-dim' }, `${ms}ms`));
        if (data.errors?.length) {
          for (const err of data.errors) metaLine.append(h('span', { class: 'err' }, err.message));
        }
      } catch (e) { clear(metaLine).append(h('span', { class: 'err' }, e.message)); }
    }

    const docsWrap = h('div', { class: 'card pad-sm', style: { maxHeight: '480px', overflow: 'auto' } });
    async function loadDocs() {
      try {
        const revealed = await get(`/api/admin/projects/${state.projectId}/keys/reveal`);
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${revealed.anon}` },
          body: JSON.stringify({ query: '{ __schema { queryType { name } mutationType { name } types { name kind fields { name } } } }' }),
        });
        const { data } = await res.json();
        const types = (data?.__schema?.types || []).filter((t) => t.fields && !['Query', 'Mutation'].includes(t.name));
        clear(docsWrap);
        docsWrap.append(h('div', { class: 'micro', style: { marginBottom: '8px' } }, 'Generated types'));
        for (const t of types) {
          docsWrap.append(h('div', { style: { padding: '4px 0' } },
            h('span', { class: 'cell-mono', style: { color: 'var(--accent-strong)' } }, t.name),
            h('span', { class: 'cell-dim', style: { fontSize: '11px' } }, `  ${t.fields.map((f) => f.name).join(', ')}`)));
        }
      } catch { docsWrap.append('Schema docs unavailable'); }
    }
    loadDocs();

    page.append(
      h('div', { class: 'page-header' },
        h('div', {},
          h('h2', { class: 'page-title' }, 'GraphQL'),
          h('p', { class: 'page-subtitle' }, `Schema generated from your database: queries, mutations, relationships, pagination and introspection. Subscriptions stream over the Realtime WebSocket (documented — this HTTP endpoint returns a clear error if you send one). Endpoint: ${endpoint}`)),
        h('div', { class: 'page-actions' }, keySel,
          h('button', { class: 'btn btn-primary', onclick: run }, icon('play'), 'Run  (Ctrl+↵)'))),
      h('div', { class: 'split', style: { gridTemplateColumns: '1fr 280px' } },
        h('div', {},
          h('div', { class: 'editor-shell' }, h('div', { class: 'editor-toolbar' }, h('span', { class: 'micro' }, 'Query')), h('div', { class: 'editor-body' }, highlight, query)),
          h('div', { class: 'field', style: { marginTop: '10px' } }, h('label', {}, 'Variables (JSON)'), varsInput),
          metaLine, responseArea),
        docsWrap));
  },
});
