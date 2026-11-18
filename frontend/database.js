// database.js — Database page: connections (create/test/health/switch),
// schema browser with table/column/index management, row browser with editing,
// relationships, row-level-security policies, branching and migrations.
import {
  h, clear, get, post, patch, del, icon, state, modal, field, formRow, toast,
  toastSuccess, toastError, confirmDialog, emptyState, fmtBytes, fmtDate,
  badge, jsonView, safeParse, fmtNumber, requireProject, dataTable, contextMenu,
} from './components.js';
import { register } from './router.js';

let activeConnection = null;
let activeTable = null;

register('database', {
  title: 'Database',
  async render(page) {
    if (!requireProject(page, 'Database')) return;
    const tabs = h('div', { class: 'tabs' },
      tabBtn('Connections', true), tabBtn('Schema'), tabBtn('Rows'), tabBtn('Policies'), tabBtn('Branches'), tabBtn('Migrations'));
    const body = h('div', {});
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      qsa('.tab', tabs).forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      renderTab(btn.dataset.tab, body);
    });
    page.append(
      h('div', { class: 'page-header' },
        h('div', {},
          h('h2', { class: 'page-title' }, 'Database'),
          h('p', { class: 'page-subtitle' }, 'Connections, schema, row-level security, branching and migrations for this project.')),
        h('div', { class: 'page-actions' },
          h('button', { class: 'btn btn-secondary', onclick: () => goRoute('sql') }, icon('terminal'), 'SQL Editor'),
          h('button', { class: 'btn btn-primary', onclick: () => showConnectionModal(() => renderTab('connections', body)) }, icon('plus'), 'Add connection'))),
      tabs, body);
    renderTab('connections', body);

    function tabBtn(label, active) {
      const b = h('button', { class: `tab ${active ? 'active' : ''}`, 'data-tab': label.toLowerCase() }, label);
      return b;
    }
    function goRoute(r) { location.hash = `#/${r}`; }
  },
});

async function renderTab(name, body) {
  clear(body);
  if (name === 'connections') await renderConnections(body);
  else if (name === 'schema') await renderSchema(body);
  else if (name === 'rows') await renderRows(body);
  else if (name === 'policies') await renderPolicies(body);
  else if (name === 'branches') await renderBranches(body);
  else if (name === 'migrations') await renderMigrations(body);
}

async function ensureConnections() {
  const { connections } = await get(`/api/admin/projects/${state.projectId}/connections`);
  if (!connections.length) return [];
  if (!activeConnection || !connections.find((c) => c.id === activeConnection)) {
    activeConnection = connections.find((c) => c.is_default)?.id || connections[0].id;
  }
  return connections;
}

/* ── Connections ── */
async function renderConnections(body) {
  const connections = await ensureConnections();
  if (!connections.length) {
    body.append(emptyState({
      title: 'No database connections',
      sub: 'Add the embedded SQLite provider or connect PostgreSQL / MySQL / MariaDB / MongoDB / BadgerDB.',
      icon: 'database',
      action: h('button', { class: 'btn btn-primary', onclick: () => showConnectionModal(() => renderConnections(body)) }, icon('plus'), 'Add connection'),
    }));
    return;
  }
  const sel = h('select', { class: 'input', style: { maxWidth: '280px' }, onchange: (e) => { activeConnection = e.target.value; } },
    ...connections.map((c) => h('option', { value: c.id, selected: c.id === activeConnection }, `${c.name} (${c.provider})${c.is_default ? ' ★' : ''}`)));
  body.append(h('div', { class: 'table-toolbar' }, sel,
    h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
      try {
        const health = await post(`/api/admin/connections/${activeConnection}/refresh`);
        toast[health.status === 'ok' ? 'Success' : 'Error'] && (health.status === 'ok' ? toastSuccess(`${health.provider}: healthy`) : toastError(`Health: ${health.error || health.status}`));
      } catch (e) { toastError(e); }
    } }, icon('refresh'), 'Test health'),
    h('button', { class: 'btn btn-ghost btn-sm', onclick: () => showConnectionModal(() => renderConnections(body)) }, icon('plus'), 'Add')));

  const grid = h('div', { class: 'grid grid-2' });
  for (const c of connections) {
    const caps = Object.entries(c.capabilities || {}).filter(([, v]) => v === true || typeof v === 'string').map(([k, v]) => `${k}:${v}`).join(' · ');
    grid.append(h('div', { class: 'card' },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        h('div', { class: `tile-icon ${c.status === 'ok' ? 'green' : ''}` }, icon(c.provider === 'mongodb' ? 'braces' : 'database')),
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('div', { class: 'tile-title' }, c.name, c.is_default ? ' ★' : ''),
          h('div', { class: 'tile-sub mono' }, c.provider)),
        badge(c.status?.toUpperCase() || 'UNKNOWN', c.status === 'ok' ? 'green' : 'red')),
      h('div', { class: 'tile-sub', style: { margin: '8px 0' } }, caps || '—'),
      h('div', { class: 'cell-dim mono', style: { fontSize: '11px' } }, JSON.stringify(c.config)),
      h('div', { style: { display: 'flex', gap: '6px', marginTop: '10px', flexWrap: 'wrap' } },
        !c.is_default ? h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => { await post(`/api/admin/connections/${c.id}/set-default`); toastSuccess('Default connection set'); renderConnections(body); } }, 'Set default') : null,
        h('button', { class: 'btn btn-ghost btn-sm', onclick: () => showEditConnectionModal(c, () => renderConnections(body)) }, icon('edit'), 'Edit'),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
          const dump = await fetch(`/api/admin/connections/${c.id}/export-dump`, { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('bloop.adminToken')}` } });
          const blob = await dump.blob();
          const a = h('a', { href: URL.createObjectURL(blob), download: `${c.name}-dump.sql` }); a.click();
        } }, icon('download'), 'Dump'),
        h('button', { class: 'btn btn-ghost btn-sm danger-text', onclick: async () => {
          const ok = await confirmDialog({ title: `Delete connection “${c.name}”?`, message: 'The connection entry is removed. Database files are kept on disk.', confirmText: 'Delete', danger: true });
          if (!ok) return;
          try { await del(`/api/admin/connections/${c.id}`); toastSuccess('Connection deleted'); renderConnections(body); }
          catch (e) { toastError(e); }
        } }, icon('trash')))));
  }
  body.append(grid);
}

const PROVIDER_FIELDS = {
  sqlite: [{ key: 'filename', label: 'Database file', hint: 'Leave empty to auto-place under this project (storage/projects/<id>/db/)' }],
  postgres: [{ key: 'host', label: 'Host', value: 'localhost' }, { key: 'port', label: 'Port', value: '5432' }, { key: 'database', label: 'Database' }, { key: 'user', label: 'User' }, { key: 'password', label: 'Password', secret: true }, { key: 'ssl', label: 'Use SSL', checkbox: true }],
  mysql: [{ key: 'host', label: 'Host', value: 'localhost' }, { key: 'port', label: 'Port', value: '3306' }, { key: 'database', label: 'Database' }, { key: 'user', label: 'User' }, { key: 'password', label: 'Password', secret: true }],
  mariadb: [{ key: 'host', label: 'Host', value: 'localhost' }, { key: 'port', label: 'Port', value: '3306' }, { key: 'database', label: 'Database' }, { key: 'user', label: 'User' }, { key: 'password', label: 'Password', secret: true }],
  mongodb: [{ key: 'url', label: 'Connection URL', hint: 'mongodb://user:pass@host:27017' }, { key: 'database', label: 'Database name' }],
  badger: [{ key: 'endpoint', label: 'Sidecar endpoint', value: 'http://127.0.0.1:8089', hint: 'Run docker/badger-sidecar (see docs/docker.md)' }],
};

function showConnectionModal(onDone, existing = null) {
  const providerSel = h('select', { class: 'input', disabled: !!existing },
    ...Object.keys(PROVIDER_FIELDS).map((p) => h('option', { value: p, selected: existing?.provider === p }, p)));
  const name = h('input', { class: 'input', value: existing?.name || '', placeholder: 'main' });
  const fieldsWrap = h('div', {});
  const testResult = h('div', {});
  const envSel = h('select', { class: 'input' }, h('option', { value: '' }, 'All environments'), ...['dev', 'staging', 'prod'].map((e) => h('option', { value: e }, e)));

  function renderFields() {
    clear(fieldsWrap);
    for (const f of PROVIDER_FIELDS[providerSel.value] || []) {
      if (f.checkbox) {
        fieldsWrap.append(h('label', { class: 'checkbox-row' }, h('input', { type: 'checkbox', 'data-key': f.key, checked: !!existing && !!safeParse(JSON.stringify(existing.config || {}))[f.key] }), f.label));
        continue;
      }
      const input = h('input', { class: 'input mono', type: f.secret ? 'password' : 'text', placeholder: f.value || f.label, value: existing ? '••••••••' : f.value || '', 'data-key': f.key });
      if (existing && f.secret) input.dataset.masked = '1';
      fieldsWrap.append(field(f.label, input, { hint: f.hint }));
    }
  }
  renderFields();
  providerSel.addEventListener('change', () => { testResult.textContent = ''; renderFields(); });

  const btnTest = h('button', { class: 'btn btn-secondary', onclick: async () => {
    const config = collectConfig();
    if (!config) return;
    btnTest.disabled = true; btnTest.textContent = 'Testing…';
    try {
      const r = await post('/api/admin/connections/test', { provider: providerSel.value, config });
      if (r.status === 'ok') { testResult.className = 'callout green'; testResult.textContent = `Connection OK — ${r.version || r.database || ''}`; }
      else { testResult.className = 'error-box'; testResult.textContent = r.error || 'unreachable'; }
    } catch (e) { testResult.className = 'error-box'; testResult.textContent = e.message; }
    btnTest.disabled = false; btnTest.textContent = 'Test connection';
  } }, 'Test connection');

  function collectConfig() {
    const config = {};
    for (const input of qsa('[data-key]', fieldsWrap)) {
      const key = input.dataset.key;
      if (input.type === 'checkbox') { config[key] = input.checked; continue; }
      const value = input.value;
      if (input.dataset.masked === '1' && value === '••••••••') continue; // keep stored value
      if (value === '' && input.placeholder && !['password'].includes(key)) config[key] = input.placeholder;
      else if (value !== '') config[key] = value;
    }
    for (const f of PROVIDER_FIELDS[providerSel.value] || []) {
      if (config[f.key] === undefined && f.value && !existing) config[f.key] = f.value;
    }
    if (providerSel.value === 'postgres' && config.ssl !== undefined) config.ssl = config.ssl === true || config.ssl === 'true';
    return config;
  }

  const btnCreate = h('button', { class: 'btn btn-primary', onclick: async () => {
    if (!name.value.trim()) return toastError('Name required');
    const config = collectConfig();
    btnCreate.disabled = true;
    try {
      if (existing) {
        await patch(`/api/admin/connections/${existing.id}`, { name: name.value, config });
        toastSuccess('Connection updated (re-tested)');
      } else {
        const c = await post(`/api/admin/projects/${state.projectId}/connections`, {
          name: name.value, provider: providerSel.value, config, isDefault: !activeConnection,
        });
        toastSuccess(`Connection “${c.name}” created and tested`);
      }
      m.close(); onDone?.();
    } catch (e) { toastError(e); btnCreate.disabled = false; }
  } }, existing ? 'Save changes' : 'Create connection');

  const m = modal({
    title: existing ? `Edit connection — ${existing.name}` : 'Add database connection',
    body: h('div', {},
      formRow(field('Name', name), field('Environment scope', envSel)),
      field('Provider', providerSel),
      fieldsWrap,
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '4px' } }, btnTest),
      h('div', { style: { marginTop: '10px' } }, testResult),
      h('div', { class: 'callout', style: { marginTop: '10px' } },
        'PostgreSQL/MySQL/MariaDB/MongoDB need their optional driver installed once on the server: ',
        h('span', { class: 'mono' }, 'npm install pg mysql2 mongodb'))),
    footer: btnCreate,
  });
}

function showEditConnectionModal(c, onDone) {
  showConnectionModal(onDone, c);
}

/* ── Schema browser ── */
async function renderSchema(body) {
  const connections = await ensureConnections();
  if (!connections.length) return body.append(emptyState({ title: 'No connection', icon: 'database' }));
  let schema = null;
  try { schema = (await get(`/api/admin/connections/${activeConnection}/schema`)).tables; }
  catch (e) { return body.append(h('div', { class: 'error-box' }, e.message)); }
  if (!schema.length) {
    body.append(emptyState({
      title: 'No tables yet',
      sub: 'Create tables from the SQL Editor with CREATE TABLE statements, or add one here.',
      icon: 'table',
      action: h('button', { class: 'btn btn-primary', onclick: () => showCreateTableModal(() => renderSchema(body)) }, icon('plus'), 'Create table'),
    }));
    return;
  }
  const pane = h('div', { class: 'list-pane' });
  const detail = h('div', {});
  const split = h('div', { class: 'split' }, pane, detail);

  for (const t of schema) {
    pane.append(h('button', { class: `list-pane-item ${t.name === activeTable ? 'active' : ''}`, onclick: () => {
      activeTable = t.name;
      qsa('.list-pane-item', pane).forEach((x) => x.classList.remove('active'));
      pane.children[schema.findIndex((x) => x.name === t.name)].classList.add('active');
      renderTableDetail(t, detail, () => renderSchema(body));
    } }, icon(t.type === 'view' ? 'eye' : 'table'), t.name,
    h('span', { class: 'cell-dim', style: { marginLeft: 'auto', fontSize: '11px' } }, `${t.columns.length} cols`)));
  }
  body.append(split);
  const first = schema.find((t) => t.name === activeTable) || schema[0];
  activeTable = first.name;
  renderTableDetail(first, detail, () => renderSchema(body));
}

function renderTableDetail(t, detail, refresh) {
  clear(detail);

  const header = h('div', { class: 'card-header' },
    h('div', {},
      h('div', { class: 'card-title' }, t.name),
      h('div', { class: 'card-sub' }, `${t.type} · ${t.columns.length} columns · ${t.indexes.length} indexes`)),
    h('div', { style: { display: 'flex', gap: '6px' } },
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => showAddColumnModal(t, refresh) }, icon('plus'), 'Column'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => showCreateIndexModal(t, refresh) }, icon('list'), 'Index'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
        const name = prompt('Rename table to:', t.name);
        if (!name) return;
        try { await post(`/api/admin/connections/${activeConnection}/tables/${t.name}/rename`, { name }); toastSuccess('Table renamed'); refresh(); }
        catch (e) { toastError(e); }
      } }, 'Rename'),
      h('button', { class: 'btn btn-danger btn-sm', onclick: async () => {
        const ok = await confirmDialog({ title: `Drop table "${t.name}"?`, message: 'All rows are permanently deleted.', confirmText: 'Drop table', danger: true, requireText: t.name });
        if (!ok) return;
        try { await del(`/api/admin/connections/${activeConnection}/tables/${t.name}`, { confirm: true }); toastSuccess('Table dropped'); refresh(); }
        catch (e) { toastError(e); }
      } }, icon('trash'), 'Drop')));

  const colsHeader = h('div', { class: 'micro', style: { marginBottom: '8px' } }, 'Columns');
  const colRows = t.columns.map((c) => h('tr', {},
    h('td', { class: 'cell-mono' }, c.name),
    h('td', { class: 'cell-dim' }, c.type || '—'),
    h('td', {}, c.nullable ? 'yes' : 'NO'),
    h('td', { class: 'cell-dim mono' }, c.default === null || c.default === undefined ? '—' : String(c.default)),
    h('td', {}, c.pk ? badge('PK', 'green') : ''),
    h('td', {}, h('div', { class: 'row-actions' },
      h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
        const ok = await confirmDialog({ title: `Drop column "${c.name}"?`, confirmText: 'Drop', danger: true });
        if (!ok) return;
        try { await del(`/api/admin/connections/${activeConnection}/tables/${t.name}/columns/${c.name}`); toastSuccess('Column dropped'); refresh(); }
        catch (e) { toastError(e); }
      } }, icon('trash'))))));
  const colsCard = h('div', { class: 'card pad-sm', style: { marginBottom: '12px' } },
    colsHeader,
    h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', {}, 'Nullable'), h('th', {}, 'Default'), h('th', {}, 'Key'), h('th', {}, ''))),
      h('tbody', {}, ...colRows))));

  const idxChildren = t.indexes.length ? t.indexes.map((i) => h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0' } },
    i.unique ? badge('UNIQUE', 'outline') : null,
    h('span', { class: 'cell-mono', style: { flex: '1' } }, i.name),
    h('span', { class: 'cell-dim', style: { fontSize: '11px' } }, (i.columns || []).join(', ') || i.definition || ''),
    h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
      try { await del(`/api/admin/connections/${activeConnection}/indexes/${i.name}?table=${t.name}`); toastSuccess('Index dropped'); refresh(); }
      catch (e) { toastError(e); }
    } }, icon('trash')))) : [h('div', { class: 'cell-dim' }, 'None')];
  const idxCard = h('div', { class: 'card pad-sm' },
    h('div', { class: 'micro', style: { marginBottom: '8px' } }, 'Indexes'), ...idxChildren);

  const fkChildren = (t.foreignKeys || []).length
    ? t.foreignKeys.map((fk) => h('div', { class: 'cell-mono', style: { padding: '4px 0' } },
      `${fk.column ?? fk.column_name} → ${fk.referencesTable ?? fk.referenced_table_name}.${fk.referencesColumn ?? fk.referenced_column_name}`))
    : [h('div', { class: 'cell-dim' }, 'None')];
  const fkCard = h('div', { class: 'card pad-sm' },
    h('div', { class: 'micro', style: { marginBottom: '8px' } }, 'Foreign keys'), ...fkChildren);

  const sizeCard = h('div', { class: 'card pad-sm' },
    h('div', { class: 'micro', style: { marginBottom: '8px' } }, 'Table size'),
    t.size ? h('div', {}, `${fmtNumber(t.size.rows)} rows · ${fmtBytes(t.size.bytes)}`) : h('div', { class: 'cell-dim' }, '—'));

  detail.append(header, colsCard, h('div', { class: 'grid grid-2' }, idxCard, fkCard, sizeCard));
}

function showAddColumnModal(t, refresh) {
  const name = h('input', { class: 'input mono', placeholder: 'column_name' });
  const type = h('select', { class: 'input' }, ...['text', 'integer', 'bigint', 'real', 'boolean', 'json', 'datetime', 'blob'].map((tp) => h('option', { value: tp }, tp)));
  const nullable = h('input', { type: 'checkbox', checked: true });
  const m = modal({
    title: `Add column to “${t.name}”`,
    body: h('div', {},
      formRow(field('Name', name), field('Type', type)),
      h('label', { class: 'checkbox-row' }, nullable, 'Nullable')),
    footer: h('button', { class: 'btn btn-primary', onclick: async () => {
      try {
        await post(`/api/admin/connections/${activeConnection}/tables/${t.name}/columns`, { name: name.value, type: type.value, nullable: nullable.checked });
        toastSuccess('Column added');
        m.close(); refresh();
      } catch (e) { toastError(e); }
    } }, 'Add column'),
  });
}

function showCreateIndexModal(t, refresh) {
  const cols = h('input', { class: 'input mono', placeholder: 'col1,col2' });
  const unique = h('input', { type: 'checkbox' });
  const m = modal({
    title: `Create index on “${t.name}”`,
    body: h('div', {},
      field('Columns (comma-separated)', cols),
      h('label', { class: 'checkbox-row' }, unique, 'Unique index')),
    footer: h('button', { class: 'btn btn-primary', onclick: async () => {
      try {
        await post(`/api/admin/connections/${activeConnection}/tables/${t.name}/indexes`, {
          columns: cols.value.split(',').map((c) => c.trim()).filter(Boolean), unique: unique.checked,
        });
        toastSuccess('Index created');
        m.close(); refresh();
      } catch (e) { toastError(e); }
    } }, 'Create index'),
  });
}

function showCreateTableModal(refresh) {
  const name = h('input', { class: 'input mono', placeholder: 'table_name' });
  const colsDef = h('textarea', { class: 'input mono', placeholder: 'id:integer:pk\ntitle:text\ncreated_at:datetime', style: { minHeight: '120px' } });
  const m = modal({
    title: 'Create table',
    body: h('div', {},
      field('Table name', name),
      field('Columns (one per line: name:type[:pk][:unique])', colsDef, { hint: 'Types: text, integer, bigint, real, boolean, json, datetime, blob' })),
    footer: h('button', { class: 'btn btn-primary', onclick: async () => {
      const columns = colsDef.value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
        const [colName, colType = 'text', ...flags] = line.split(':').map((s) => s.trim());
        return { name: colName, type: colType, pk: flags.includes('pk'), unique: flags.includes('unique'), nullable: !flags.includes('notnull') };
      });
      try {
        await post(`/api/admin/connections/${activeConnection}/tables`, { name: name.value, columns, ifNotExists: false });
        toastSuccess(`Table “${name.value}” created`);
        m.close(); refresh();
      } catch (e) { toastError(e); }
    } }, 'Create table'),
  });
}

/* ── Row browser ── */
async function renderRows(body) {
  const connections = await ensureConnections();
  if (!connections.length) return body.append(emptyState({ title: 'No connection', icon: 'database' }));
  let schema;
  try { schema = (await get(`/api/admin/connections/${activeConnection}/schema`)).tables; }
  catch (e) { return body.append(h('div', { class: 'error-box' }, e.message)); }
  if (!schema.length) return body.append(emptyState({ title: 'No tables', icon: 'table' }));
  const tableNames = schema.map((t) => t.name);
  if (!activeTable || !tableNames.includes(activeTable)) activeTable = tableNames[0];
  const sel = h('select', { class: 'input', style: { maxWidth: '240px' }, onchange: (e) => { activeTable = e.target.value; loadRows(); } },
    ...tableNames.map((t) => h('option', { value: t, selected: t === activeTable }, t)));
  const search = h('input', { class: 'input', placeholder: 'Search all columns…', style: { width: '220px' }, onkeydown: (e) => { if (e.key === 'Enter') loadRows(); } });
  const container = h('div', {});
  let page = 1;
  const pageSize = 25;

  async function loadRows() {
    clear(container);
    container.append(h('div', { class: 'loading-block' }, h('div', { class: 'spinner' }), 'Loading rows…'));
    try {
      const data = await get(`/api/admin/connections/${activeConnection}/tables/${activeTable}/rows?limit=${pageSize}&offset=${(page - 1) * pageSize}&search=${encodeURIComponent(search.value || '')}`);
      clear(container);
      if (!data.rows.length) { container.append(emptyState({ title: 'No rows', icon: 'table' })); return; }
      const cols = Object.keys(data.rows[0]).map((key) => ({
        key,
        label: key,
        render: (row) => {
          const v = row[key];
          if (v === null) return h('span', { class: 'cell-dim' }, 'NULL');
          if (typeof v === 'object') return h('span', { class: 'cell-mono cell-dim' }, JSON.stringify(v).slice(0, 60));
          return String(v).slice(0, 80);
        },
      }));
      const table = dataTable({
        columns: cols,
        rows: data.rows,
        onRowClick: (row) => showRowEditor(row),
        rowActions: (row) => [h('button', { class: 'btn btn-ghost btn-sm', onclick: (e) => { e.stopPropagation(); showRowEditor(row); } }, icon('edit')),
          h('button', { class: 'btn btn-ghost btn-sm', onclick: async (e) => {
            e.stopPropagation();
            const pkCol = cols[0].key;
            const ok = await confirmDialog({ title: 'Delete row?', message: `DELETE FROM ${activeTable} WHERE ${pkCol} = ${row[pkCol]}`, confirmText: 'Delete', danger: true });
            if (!ok) return;
            try {
              await post(`/api/admin/connections/${activeConnection}/query`, { sql: `DELETE FROM ${activeTable} WHERE ${pkCol} = ?`, params: [row[pkCol]] });
              toastSuccess('Row deleted'); loadRows();
            } catch (err) { toastError(err); }
          } }, icon('trash'))],
        footer: () => pagination2(data),
      });
      container.append(table);
    } catch (e) {
      clear(container);
      container.append(h('div', { class: 'error-box' }, e.message));
    }
  }
  function pagination2(data) {
    const pages = Math.max(1, Math.ceil((data.total || 0) / pageSize));
    return h('div', { class: 'table-footer' },
      h('span', {}, `${fmtNumber(data.total)} rows · page ${page}/${pages}`),
      h('div', { style: { display: 'flex', gap: '6px' } },
        h('button', { class: 'btn btn-ghost btn-sm', disabled: page <= 1, onclick: () => { page--; loadRows(); } }, '←'),
        h('button', { class: 'btn btn-ghost btn-sm', disabled: page >= pages, onclick: () => { page++; loadRows(); } }, '→')));
  }

  function showRowEditor(row) {
    const fields = h('div', {});
    const inputs = {};
    for (const [k, v] of Object.entries(row)) {
      const input = h('textarea', { class: 'input mono', style: { minHeight: v !== null && String(v).length > 60 ? '70px' : '34px' } });
      input.value = v === null ? '' : (typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v));
      inputs[k] = { input, original: v };
      fields.append(field(k, input, { hint: v === null ? 'NULL — leave empty to keep NULL' : null }));
    }
    modal({
      title: `Edit row — ${activeTable}`,
      size: 'modal-lg',
      body: fields,
      footer: h('button', { class: 'btn btn-primary', onclick: async () => {
        const sets = [];
        const params = [];
        for (const [k, { input, original }] of Object.entries(inputs)) {
          let v = input.value;
          if (v === '' && original === null) continue;
          if (typeof original === 'number' && v !== '' && !Number.isNaN(Number(v))) v = Number(v);
          else if (typeof original === 'object' && original !== null) { try { v = JSON.parse(v); } catch { } }
          if (JSON.stringify(v) !== JSON.stringify(original)) { sets.push(`${k} = ?`); params.push(v); }
        }
        if (!sets.length) return toastError('No changes');
        const pkCol = Object.keys(row)[0];
        try {
          await post(`/api/admin/connections/${activeConnection}/query`, {
            sql: `UPDATE ${activeTable} SET ${sets.join(', ')} WHERE ${pkCol} = ?`,
            params: [...params, row[pkCol]],
          });
          toastSuccess('Row updated'); m.close(); loadRows();
        } catch (e) { toastError(e); }
      } }, 'Save row'),
    });
  }

  body.append(
    h('div', { class: 'table-toolbar' }, sel, search,
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => loadRows() }, icon('refresh'), 'Refresh'),
      h('button', { class: 'btn btn-secondary btn-sm', onclick: () => showInsertRowModal(loadRows) }, icon('plus'), 'Insert row')),
    container);
  loadRows();
}

function showInsertRowModal(refresh) {
  const colsInput = h('input', { class: 'input mono', placeholder: 'col1, col2, col3' });
  const valuesInput = h('textarea', { class: 'input mono', placeholder: 'value1, value2, null', style: { minHeight: '80px' } });
  const m = modal({
    title: `Insert row into “${activeTable}”`,
    body: h('div', {},
      field('Columns', colsInput),
      field('Values (same order)', valuesInput, { hint: 'Use null for NULL values; numbers and strings as-is' })),
    footer: h('button', { class: 'btn btn-primary', onclick: async () => {
      const cols = colsInput.value.split(',').map((c) => c.trim()).filter(Boolean);
      const values = valuesInput.value.split('\n').join(' ').split(',').map((v) => {
        const t = v.trim();
        if (t.toLowerCase() === 'null') return null;
        if (t !== '' && !Number.isNaN(Number(t))) return Number(t);
        return t.replace(/^'(.*)'$/, '$1');
      });
      if (cols.length !== values.length) return toastError('Column/value count mismatch');
      try {
        await post(`/api/admin/connections/${activeConnection}/query`, {
          sql: `INSERT INTO ${activeTable} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          params: values,
        });
        toastSuccess('Row inserted'); m.close(); refresh?.();
      } catch (e) { toastError(e); }
    } }, 'Insert'),
  });
}

/* ── Policies ── */
async function renderPolicies(body) {
  const { policies } = await get(`/api/admin/projects/${state.projectId}/policies`);
  body.append(h('div', { class: 'page-header', style: { padding: '0' } },
    h('div', {},
      h('h3', { class: 'card-title' }, 'Row-level security'),
      h('p', { class: 'page-subtitle' }, 'Policies gate anonymous/authenticated API access per table. The service key and dashboard admins bypass them.')),
    h('button', { class: 'btn btn-primary', onclick: () => showAddPolicyModal(() => renderPolicies(body)) }, icon('plus'), 'Add policy')));
  if (!policies.length) {
    body.append(emptyState({
      title: 'No policies — API access is denied for anon/authenticated users',
      sub: 'Add policies like "user_id == auth.uid()" or "public == true or auth.uid() == owner_id" to grant access.',
      icon: 'lock',
      action: h('button', { class: 'btn btn-primary', onclick: () => showAddPolicyModal(() => renderPolicies(body)) }, 'Create first policy'),
    }));
    return;
  }
  body.append(dataTable({
    columns: [
      { key: 'table_name', label: 'Table' },
      { key: 'policy_name', label: 'Policy' },
      { key: 'command', label: 'Command' },
      { key: 'expression', label: 'Expression', render: (r) => h('span', { class: 'cell-mono' }, r.expression) },
      { key: 'roles', label: 'Roles', render: (r) => h('span', { class: 'cell-dim' }, r.roles) },
      { key: 'enabled', label: '', render: (r) => badge(r.enabled ? 'ON' : 'OFF', r.enabled ? 'green' : 'gray') },
    ],
    rows: policies,
    rowActions: (row) => [h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
      await del(`/api/admin/projects/${state.projectId}/policies/${row.id}`);
      toastSuccess('Policy removed'); renderPolicies(body);
    } }, icon('trash'))],
  }));
}

function showAddPolicyModal(refresh) {
  const table = h('input', { class: 'input mono', placeholder: 'table_name' });
  const policyName = h('input', { class: 'input', placeholder: 'owner-select' });
  const command = h('select', { class: 'input' }, ...['select', 'insert', 'update', 'delete', 'all'].map((c) => h('option', { value: c }, c)));
  const expression = h('input', { class: 'input mono', placeholder: 'user_id == auth.uid()' });
  const check = h('div', { class: 'callout', style: { display: 'none' } });
  expression.addEventListener('input', async () => {
    if (!expression.value) { check.style.display = 'none'; return; }
    const r = await post('/api/admin/policies/validate', { expression: expression.value }).catch(() => ({ ok: false, error: 'offline' }));
    check.style.display = '';
    check.className = r.ok ? 'callout green' : 'error-box';
    check.textContent = r.ok ? 'Expression compiles ✓' : r.error;
  });
  const m = modal({
    title: 'Add row-level security policy',
    body: h('div', {},
      formRow(field('Table', table), field('Policy name', policyName)),
      formRow(field('Command', command), field('Expression', expression, { hint: 'Supports: auth.uid(), auth.role(), auth.jwt.claim.X, ==, !=, >, <, in, contains, and, or, not' })),
      check),
    footer: h('button', { class: 'btn btn-primary', onclick: async () => {
      try {
        await post(`/api/admin/projects/${state.projectId}/policies`, {
          table: table.value, name: policyName.value, command: command.value, expression: expression.value, roles: ['anon', 'authenticated'],
        });
        toastSuccess('Policy created'); m.close(); refresh?.();
      } catch (e) { toastError(e); }
    } }, 'Create policy'),
  });
}

/* ── Branches ── */
async function renderBranches(body) {
  const connections = await ensureConnections();
  if (!connections.length) return body.append(emptyState({ title: 'No connection', icon: 'database' }));
  const sel = h('select', { class: 'input', style: { maxWidth: '260px' }, onchange: () => load() },
    ...connections.map((c) => h('option', { value: c.id, selected: c.id === activeConnection }, c.name)));
  const container = h('div', {});
  async function load() {
    clear(container);
    const { branches } = await get(`/api/admin/projects/${state.projectId}/branches?connectionId=${sel.value}`);
    container.append(h('div', { style: { display: 'flex', gap: '8px', margin: '10px 0' } },
      h('button', { class: 'btn btn-secondary', onclick: async () => {
        const name = prompt('Branch name:', 'feature-x');
        if (!name) return;
        try {
          const r = await post(`/api/admin/projects/${state.projectId}/branches`, { connectionId: sel.value, branchName: name });
          toastSuccess(`Branch created via ${r.strategy}`); load();
        } catch (e) { toastError(e); }
      } }, icon('branch'), 'Create branch'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
        const branch = branches[0];
        if (!branch) return toastError('Create a branch first');
        const r = await post(`/api/admin/projects/${state.projectId}/branches/compare`, { connectionIdA: branch.connectionId, connectionIdB: sel.value });
        modal({ title: 'Schema diff (branch → main)', size: 'modal-lg', body: jsonView(r) });
      } }, 'Compare'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
        const branch = branches[0];
        if (!branch) return toastError('Create a branch first');
        const preview = await post(`/api/admin/projects/${state.projectId}/branches/promote`, { branchConnectionId: branch.connectionId, targetConnectionId: sel.value, apply: false });
        const ok = await confirmDialog({
          title: 'Promote branch to this connection?',
          message: `${preview.statements.length} additive DDL statements will run. Destructive differences are never auto-dropped.`,
          confirmText: 'Apply & promote',
        });
        if (!ok) return;
        const r2 = await post(`/api/admin/projects/${state.projectId}/branches/promote`, { branchConnectionId: branch.connectionId, targetConnectionId: sel.value, apply: true, confirm: true });
        toastSuccess(`Promoted — ${r2.applied} statements applied`);
      } }, icon('zap'), 'Promote first branch')));
    if (!branches.length) {
      container.append(emptyState({
        title: 'No branches',
        sub: 'SQLite branches are file clones; PostgreSQL uses database clones; MySQL/MariaDB use dump clones; MongoDB clones namespaces. The strategy per provider is reported honestly.',
        icon: 'git',
      }));
    } else {
      container.append(dataTable({
        columns: [
          { key: 'name', label: 'Branch' },
          { key: 'provider', label: 'Provider' },
          { key: 'strategy', label: 'Strategy' },
          { key: 'createdAt', label: 'Created', render: (r) => fmtDate(r.createdAt) },
          { key: 'connectionStatus', label: 'Status', render: (r) => badge(r.connectionStatus?.toUpperCase() || '—', r.connectionStatus === 'ok' ? 'green' : 'gray') },
        ],
        rows: branches,
        rowActions: (row) => [h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
          const ok = await confirmDialog({ title: `Delete branch “${row.name}”?`, message: 'The branch database/file is removed.', confirmText: 'Delete', danger: true });
          if (!ok) return;
          await del(`/api/admin/projects/${state.projectId}/branches/${row.name}`);
          toastSuccess('Branch deleted'); load();
        } }, icon('trash'))],
      }));
    }
  }
  body.append(h('div', { class: 'table-toolbar' }, sel), container);
  load();
}

/* ── Migrations ── */
async function renderMigrations(body) {
  const connections = await ensureConnections();
  if (!connections.length) return body.append(emptyState({ title: 'No connection', icon: 'database' }));
  const conn = connections.find((c) => c.id === activeConnection) || connections[0];
  let data;
  try { data = await get(`/api/admin/projects/${state.projectId}/migrations?connectionId=${conn.id}`); }
  catch (e) { return body.append(h('div', { class: 'error-box' }, e.message)); }
  body.append(
    h('div', { style: { display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' } },
      h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => {
        const name = prompt('Migration name (snake_case):', 'add_users_table');
        if (!name) return;
        const r = await post(`/api/admin/projects/${state.projectId}/migrations/create`, { name });
        toastSuccess(`Created ${r.name} — edit migrations/${r.name}.sql then apply`);
      } }, icon('plus'), 'New migration'),
      h('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
        const r = await post(`/api/admin/projects/${state.projectId}/migrations/apply`, { connectionId: conn.id });
        const failed = r.results.find((x) => x.status === 'failed');
        if (failed) toastError(`${failed.filename}: ${failed.error}`);
        else toastSuccess(`${r.applied} migration(s) applied`);
        renderMigrations(body);
      } }, icon('zap'), 'Apply pending'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
        const r = await post(`/api/admin/projects/${state.projectId}/migrations/rollback`, { connectionId: conn.id, steps: 1 });
        const blocked = r.results.find((x) => x.status === 'blocked');
        const failed = r.results.find((x) => x.status === 'failed');
        if (failed) toastError(`${failed.filename}: ${failed.error}`);
        else if (blocked) toast(`${blocked.filename}: ${blocked.reason}`, { type: 'warn' });
        else toastSuccess('Rolled back one migration');
        renderMigrations(body);
      } }, icon('refresh'), 'Rollback last')),
    data.validation?.issues?.length ? h('div', { class: 'callout warn', style: { marginBottom: '12px' } },
      ...data.validation.issues.map((i) => h('div', {}, `${i.filename}: ${i.issue}`))) : null,
    data.migrations.length ? dataTable({
      columns: [
        { key: 'filename', label: 'Migration' },
        { key: 'applied', label: 'Status', render: (m) => badge(m.applied ? 'APPLIED' : 'PENDING', m.applied ? 'green' : 'gray') },
        { key: 'appliedAt', label: 'Applied', render: (m) => m.appliedAt ? fmtDate(m.appliedAt) : '—' },
        { key: 'hasDown', label: 'Rollback', render: (m) => m.hasDown ? 'down.sql ✓' : 'none' },
        { key: 'checksumMatches', label: 'Integrity', render: (m) => m.checksumMatches === null ? '—' : m.checksumMatches ? '✓' : h('span', { style: { color: 'var(--danger)' } }, 'checksum drift') },
      ],
      rows: data.migrations,
      onRowClick: async (m) => {
        const preview = await get(`/api/admin/projects/${state.projectId}/migrations/preview/${m.filename}`);
        modal({ title: m.filename, size: 'modal-lg', body: h('div', {},
          h('div', { class: 'micro', style: { marginBottom: '6px' } }, 'Up migration'),
          h('pre', { class: 'json-view', style: { maxHeight: '220px' } }, preview.up || '(empty)'),
          preview.down ? h('div', {}, h('div', { class: 'micro', style: { margin: '10px 0 6px' } }, 'Down migration'), h('pre', { class: 'json-view', style: { maxHeight: '180px' } }, preview.down)) : null) });
      },
    }) : emptyState({ title: 'No migration files', sub: 'Create one — files live in migrations/<project-slug>/ in your deployment.', icon: 'list' }));
}

import { qsa } from './components.js';
