// functions.js — two pages: Functions (server-side JS with sandboxed worker
// execution, secrets, triggers, logs, custom endpoints) and Webhooks
// (targets, delivery log with retries, signing).
import {
  h, clear, get, post, patch, del, put, icon, state, toast, toastSuccess,
  toastError, modal, field, formRow, emptyState, requireProject, badge,
  fmtDate, fmtDuration, dataTable, confirmDialog, safeParse, jsonView,
  fmtNumber, checkboxRow,
} from './components.js';
import { register } from './router.js';

const DEFAULT_FN = `// Runs in an isolated worker thread + vm sandbox.
// Define async handler(req, ctx) — ctx.secrets / ctx.env injected.
async function handler(req, ctx) {
  return {
    message: 'Hello from Bloop Functions!',
    query: req.query ?? null,
    time: new Date().toISOString(),
  };
}`;

/* ═══ Functions page ═════════════════════════════════════════════════════ */
register('functions', {
  title: 'Functions',
  async render(page) {
    if (!requireProject(page, 'Functions')) return;
    const { functions } = await get(`/api/admin/projects/${state.projectId}/functions`);
    const { endpoints } = await get(`/api/admin/projects/${state.projectId}/endpoints`);

    const list = h('div', {});
    if (!functions.length) {
      list.append(emptyState({
        title: 'No functions yet',
        sub: 'Server-side JavaScript in isolated workers: HTTP endpoints, database triggers and cron schedules. No untrusted code runs inside the server process.',
        icon: 'zap',
        action: h('button', { class: 'btn btn-primary', onclick: () => showFnModal(null, render) }, icon('plus'), 'New function'),
      }));
    } else {
      for (const fn of functions) {
        list.append(h('div', { class: 'card pad-sm', style: { marginBottom: '10px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
            h('div', { class: 'tile-icon', style: { width: '36px', height: '36px' } }, icon('zap')),
            h('div', { style: { flex: '1', minWidth: '180px' } },
              h('div', { class: 'tile-title' }, fn.name || fn.slug),
              h('div', { class: 'tile-sub mono' }, `/${fn.slug} · ${fn.timeout_ms}ms timeout`)),
            badge(fn.enabled ? 'ENABLED' : 'DISABLED', fn.enabled ? 'green' : 'gray'),
            (fn.triggers || []).length ? badge(`${fn.triggers.length} TRIGGER${fn.triggers.length > 1 ? 'S' : ''}`, 'outline') : null,
            h('div', { style: { display: 'flex', gap: '6px' } },
              h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => {
                try {
                  const r = await post(`/api/admin/projects/${state.projectId}/functions/${fn.id}/invoke`, { event: {} });
                  r.status === 'ok' ? toastSuccess(`OK in ${fmtDuration(r.durationMs)}`) : toastError(`${r.status}: ${r.error}`);
                  modal({ title: `Result — ${fn.slug}`, size: 'modal-lg', body: jsonView(r) });
                } catch (e) { toastError(e); }
              } }, icon('play'), 'Run'),
              h('button', { class: 'btn btn-ghost btn-sm', onclick: () => showFnModal(fn, render) }, icon('edit'), 'Edit'),
              h('button', { class: 'btn btn-ghost btn-sm', onclick: () => showLogsModal(fn) }, icon('list'), 'Logs'),
              h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
                const ok = await confirmDialog({ title: `Delete “${fn.slug}”?`, confirmText: 'Delete', danger: true });
                if (!ok) return;
                await del(`/api/admin/projects/${state.projectId}/functions/${fn.id}`);
                toastSuccess('Function deleted'); render();
              } }, icon('trash'))))));
      }
    }

    const endpointsCard = h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-header' },
        h('div', {}, h('div', { class: 'card-title' }, 'Custom endpoints'),
          h('div', { class: 'card-sub' }, 'Map paths to functions: /api/v1/<projectId>/x/<path>')),
        h('button', { class: 'btn btn-secondary btn-sm', onclick: () => showEndpointModal(functions, render) }, icon('plus'), 'Add endpoint')),
      endpoints.length ? dataTable({
        columns: [
          { key: 'method', label: 'Method' },
          { key: 'path', label: 'Path', className: 'cell-mono' },
          { key: 'function_slug', label: 'Function' },
          { key: 'auth_required', label: 'Auth', render: (e) => badge(e.auth_required ? 'REQUIRED' : 'PUBLIC', e.auth_required ? 'outline' : 'gray') },
        ],
        rows: endpoints,
        rowActions: (e) => [h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
          await del(`/api/admin/projects/${state.projectId}/endpoints/${e.id}`); toastSuccess('Endpoint removed'); render();
        } }, icon('trash'))],
      }) : h('div', { class: 'cell-dim', style: { padding: '10px' } }, 'No custom endpoints'));

    page.append(
      h('div', { class: 'page-header' },
        h('div', {},
          h('h2', { class: 'page-title' }, 'Functions'),
          h('p', { class: 'page-subtitle' }, 'Isolated worker execution with timeouts, memory limits, encrypted secrets, database-event triggers and cron scheduling.')),
        h('div', { class: 'page-actions' },
          h('button', { class: 'btn btn-primary', onclick: () => showFnModal(null, render) }, icon('plus'), 'New function'))),
      list, endpointsCard);

    async function showFnModal(fn, refresh) {
      let full = fn;
      if (fn) full = await get(`/api/admin/projects/${state.projectId}/functions/${fn.id}`);
      const slug = h('input', { class: 'input mono', value: full?.slug || '', placeholder: 'my-function', disabled: !!full });
      const name = h('input', { class: 'input', value: full?.name || '' });
      const timeout = h('input', { class: 'input mono', type: 'number', value: full?.timeout_ms || 10000 });
      const code = h('textarea', { class: 'input mono', style: { minHeight: '260px', fontFamily: 'var(--font-mono)' } });
      code.value = full?.code || DEFAULT_FN;
      const secrets = h('textarea', { class: 'input mono', style: { minHeight: '70px' }, placeholder: '{"API_TOKEN": "xyz"}' });
      const triggers = h('input', { class: 'input mono', placeholder: '[{"type":"database","op":"insert","table":"posts"}]', value: full ? JSON.stringify(full.triggers || []) : '[]' });
      const enabled = h('input', { type: 'checkbox' });
      enabled.checked = full ? !!full.enabled : true;
      const m = modal({
        title: full ? `Edit function — ${full.slug}` : 'New function',
        size: 'modal-xl',
        body: h('div', {},
          formRow(field('Slug', slug, { hint: 'becomes /api/v1/<project>/functions/<slug>' }), field('Name', name)),
          formRow(field('Timeout (ms)', timeout), field('', h('label', { class: 'checkbox-row', style: { marginTop: '20px' } }, enabled, 'Enabled'))),
          field('Code', code),
          field('Secrets (JSON — stored encrypted)', secrets, { hint: full ? 'Leave empty to keep existing secrets' : null }),
          field('Event triggers (JSON)', triggers, { hint: 'Database triggers fire on matching op/table; cron schedules live under scheduled jobs' })),
        footer: h('button', { class: 'btn btn-primary', onclick: async () => {
          const secretsObj = safeParse(secrets.value || '{}', null);
          const triggersArr = safeParse(triggers.value || '[]', null);
          if (secretsObj === null || triggersArr === null) return toastError('Secrets/triggers must be valid JSON');
          try {
            if (full) {
              await patch(`/api/admin/projects/${state.projectId}/functions/${full.id}`, {
                code: code.value, name: name.value, timeoutMs: Number(timeout.value),
                enabled: enabled.checked, triggers: triggersArr,
              });
              if (secrets.value.trim()) {
                await put(`/api/admin/projects/${state.projectId}/functions/${full.id}/secrets`, {
                  secrets: Object.entries(secretsObj).map(([key, value]) => ({ key, value })),
                });
              }
              toastSuccess('Function updated');
            } else {
              await post(`/api/admin/projects/${state.projectId}/functions`, {
                slug: slug.value, name: name.value, code: code.value, timeoutMs: Number(timeout.value),
                enabled: enabled.checked, triggers: triggersArr,
                secrets: Object.entries(secretsObj || {}).map(([key, value]) => ({ key, value })),
              });
              toastSuccess('Function created — test-run it from the list');
            }
            m.close(); refresh();
          } catch (e) { toastError(e); }
        } }, full ? 'Save' : 'Create'),
      });
    }

    function showLogsModal(fn) {
      modal({
        title: `Logs — ${fn.slug}`,
        size: 'modal-xl',
        body: (async () => {
          const data = await get(`/api/admin/projects/${state.projectId}/functions/${fn.id}/logs`);
          return h('div', {},
            h('div', { class: 'micro', style: { marginBottom: '8px' } }, 'Executions'),
            data.executions?.length ? dataTable({
              columns: [
                { key: 'created_at', label: 'Time', render: (r) => fmtDate(r.created_at) },
                { key: 'trigger', label: 'Trigger' },
                { key: 'status', label: 'Status', render: (r) => badge(r.status.toUpperCase(), r.status === 'ok' ? 'green' : 'red') },
                { key: 'duration_ms', label: 'Duration', render: (r) => fmtDuration(r.duration_ms) },
                { key: 'error', label: 'Error' },
              ], rows: data.executions,
            }) : h('div', { class: 'cell-dim' }, 'No executions yet'),
            h('div', { class: 'micro', style: { margin: '14px 0 8px' } }, 'Console output'),
            data.logs?.length ? h('div', { class: 'json-view', style: { maxHeight: '240px' } },
              ...data.logs.map((l) => h('div', { style: { padding: '2px 0' } },
                h('span', { class: 'cell-dim' }, fmtDate(l.created_at)), ' ',
                h('span', { style: { color: l.level === 'error' ? 'var(--danger)' : 'inherit' } }, l.message)))) : h('div', { class: 'cell-dim' }, 'No console output'));
        })(),
      });
    }
  },
});

function showEndpointModal(functions, refresh) {
  const path = h('input', { class: 'input mono', placeholder: 'orders/summary' });
  const method = h('select', { class: 'input' }, ...['GET', 'POST', 'ANY'].map((m) => h('option', { value: m }, m)));
  const fnSel = h('select', { class: 'input' }, ...functions.map((f) => h('option', { value: f.id }, f.slug)));
  if (!functions.length) return toastError('Create a function first');
  const authRequired = h('input', { type: 'checkbox' });
  const m = modal({
    title: 'Add custom endpoint',
    body: h('div', {},
      formRow(field('Path', path, { hint: 'served at /api/v1/<project>/x/<path>' }), field('Method', method)),
      field('Function', fnSel),
      checkboxRowEl2(authRequired, 'Require authentication')),
    footer: h('button', { class: 'btn btn-primary', onclick: async () => {
      try {
        await post(`/api/admin/projects/${state.projectId}/endpoints`, {
          path: path.value, method: method.value, functionId: fnSel.value, authRequired: authRequired.checked,
        });
        toastSuccess('Endpoint registered'); m.close(); refresh();
      } catch (e) { toastError(e); }
    } }, 'Add endpoint'),
  });
}

/* ═══ Webhooks page ══════════════════════════════════════════════════════ */
register('webhooks', {
  title: 'Webhooks',
  async render(page) {
    if (!requireProject(page, 'Webhooks')) return;
    const { webhooks } = await get(`/api/admin/projects/${state.projectId}/webhooks`);

    const list = h('div', {});
    if (!webhooks.length) {
      list.append(emptyState({
        title: 'No webhooks yet',
        sub: 'POST JSON to your endpoints on database changes, auth events and storage events — signed with HMAC-SHA256 and retried with exponential backoff.',
        icon: 'webhook',
        action: h('button', { class: 'btn btn-primary', onclick: () => showWhModal(null, render) }, icon('plus'), 'Add webhook'),
      }));
    } else {
      for (const wh of webhooks) {
        list.append(h('div', { class: 'card pad-sm', style: { marginBottom: '10px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
            h('div', { class: 'tile-icon', style: { width: '36px', height: '36px' } }, icon('webhook')),
            h('div', { style: { flex: '1', minWidth: '200px' } },
              h('div', { class: 'tile-title' }, wh.name),
              h('div', { class: 'tile-sub mono', style: { fontSize: '11.5px' } }, wh.url)),
            badge(wh.enabled ? 'ENABLED' : 'DISABLED', wh.enabled ? 'green' : 'gray'),
            h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
              h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => {
                const r = await post(`/api/admin/projects/${state.projectId}/webhooks/${wh.id}/test`);
                r.ping === 'delivered' ? toastSuccess(`Ping delivered (HTTP ${r.statusCode})`) : toastError(`Ping ${r.ping}: ${r.error || `HTTP ${r.statusCode}`}`);
              } }, icon('zap'), 'Ping'),
              h('button', { class: 'btn btn-ghost btn-sm', onclick: () => showDeliveriesModal(wh) }, icon('list'), 'Deliveries'),
              h('button', { class: 'btn btn-ghost btn-sm', onclick: () => showWhModal(wh, render) }, icon('edit')),
              h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
                const r = await post(`/api/admin/projects/${state.projectId}/webhooks/${wh.id}/rotate-secret`);
                modal({ title: 'New signing secret', body: h('div', {}, h('div', { class: 'callout warn', style: { marginBottom: '10px' } }, 'Update your endpoint — the old secret stops working.'), h('div', { class: 'field' }, h('label', {}, 'Secret'), h('div', { class: 'mono' }, r.secret))) });
              } }, icon('key')),
              h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
                const ok = await confirmDialog({ title: `Delete “${wh.name}”?`, confirmText: 'Delete', danger: true });
                if (!ok) return;
                await del(`/api/admin/projects/${state.projectId}/webhooks/${wh.id}`);
                toastSuccess('Webhook deleted'); render();
              } }, icon('trash')))),
          h('div', { style: { marginTop: '8px', display: 'flex', gap: '5px', flexWrap: 'wrap' } },
            ...(wh.events || []).map((e) => badge(e, 'outline')))));
      }
    }

    page.append(
      h('div', { class: 'page-header' },
        h('div', {},
          h('h2', { class: 'page-title' }, 'Webhooks'),
          h('p', { class: 'page-subtitle' }, 'Event patterns: db.insert.posts · db.* · auth.login · storage.object.created — signatures: X-Bloop-Signature: sha256=HMAC(secret, body).')),
        h('div', { class: 'page-actions' },
          h('button', { class: 'btn btn-primary', onclick: () => showWhModal(null, render) }, icon('plus'), 'Add webhook'))),
      list);

    function showWhModal(wh, refresh) {
      const name = h('input', { class: 'input', value: wh?.name || '', placeholder: 'Notify CRM' });
      const url = h('input', { class: 'input mono', value: wh?.url || '', placeholder: 'https://example.com/hooks/bloop' });
      const events = h('input', { class: 'input mono', value: wh ? (wh.events || []).join(', ') : 'db.insert.posts, db.update.posts' });
      const timeout = h('input', { class: 'input mono', type: 'number', value: wh?.timeout_ms || 10000 });
      const retries = h('input', { class: 'input mono', type: 'number', value: wh?.max_retries ?? 5 });
      const enabled = h('input', { type: 'checkbox' });
      enabled.checked = wh ? !!wh.enabled : true;
      const m = modal({
        title: wh ? `Edit webhook — ${wh.name}` : 'Add webhook',
        size: 'modal-lg',
        body: h('div', {},
          formRow(field('Name', name), field('Target URL', url)),
          field('Event patterns', events, { hint: 'comma-separated; wildcards like db.* supported' }),
          formRow(field('Timeout (ms)', timeout), field('Max retries', retries)),
          checkboxRowEl2(enabled, 'Enabled')),
        footer: h('button', { class: 'btn btn-primary', onclick: async () => {
          try {
            const payload = {
              name: name.value, url: url.value,
              events: events.value.split(',').map((s) => s.trim()).filter(Boolean),
              timeoutMs: Number(timeout.value), maxRetries: Number(retries.value), enabled: enabled.checked,
            };
            if (wh) await patch(`/api/admin/projects/${state.projectId}/webhooks/${wh.id}`, payload);
            else {
              const created = await post(`/api/admin/projects/${state.projectId}/webhooks`, payload);
              modal({ title: 'Webhook created', size: 'modal-lg', body: h('div', {},
                h('div', { class: 'callout warn', style: { marginBottom: '10px' } }, 'Signing secret — shown once:'),
                h('div', { class: 'mono', style: { wordBreak: 'break-all' } }, created.secret)) });
            }
            m.close(); refresh();
          } catch (e) { toastError(e); }
        } }, wh ? 'Save' : 'Create'),
      });
    }

    function showDeliveriesModal(wh) {
      modal({
        title: `Deliveries — ${wh.name}`,
        size: 'modal-xl',
        body: (async () => {
          const { deliveries } = await get(`/api/admin/projects/${state.projectId}/webhooks/${wh.id}/deliveries`);
          if (!deliveries.length) return emptyState({ title: 'No deliveries yet', icon: 'webhook' });
          return dataTable({
            columns: [
              { key: 'created_at', label: 'Time', render: (d) => fmtDate(d.created_at) },
              { key: 'event', label: 'Event', className: 'cell-mono' },
              { key: 'status', label: 'Status', render: (d) => badge(d.status.toUpperCase(), d.status === 'delivered' ? 'green' : d.status === 'retry_scheduled' ? 'badge-gray' : 'red') },
              { key: 'status_code', label: 'HTTP', render: (d) => d.status_code ?? '—' },
              { key: 'attempt', label: 'Try', render: (d) => `#${d.attempt}` },
              { key: 'error', label: 'Error' },
              { key: 'next_retry_at', label: 'Next retry', render: (d) => d.next_retry_at ? fmtDate(d.next_retry_at) : '—' },
            ],
            rows: deliveries,
            rowActions: (d) => d.status !== 'delivered' ? [h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
              await post(`/api/admin/projects/${state.projectId}/webhooks/deliveries/${d.id}/retry`);
              toastSuccess('Retry queued');
              document.querySelector('.modal-overlay')?.remove();
              showDeliveriesModal(wh);
            } }, icon('refresh'))] : [],
          });
        })(),
      });
    }
  },
});

function checkboxRowEl2(cb, label) {
  return h('label', { class: 'checkbox-row', style: { marginBottom: '14px' } }, cb, label);
}
