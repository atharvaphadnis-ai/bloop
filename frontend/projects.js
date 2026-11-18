// projects.js — Projects management: create/duplicate/export/import/delete,
// organization members & invitations, environments and the migration
// import wizard (Supabase / Firebase / PocketBase / Appwrite).
import {
  h, clear, get, post, patch, del, icon, state, modal, field, formRow, toast,
  toastSuccess, toastError, confirmDialog, emptyState, fmtDate, fmtBytes,
  badge, contextMenu, copyChip, fmtNumber,
} from './components.js';
import { register, go } from './router.js';

register('projects', {
  title: 'Projects',
  projectScoped: false,
  async render(page) {
    let data;
    try { data = await get('/api/admin/projects'); }
    catch (e) { return renderError(page, e); }
    state.projects = data.projects || [];
    state.orgs = data.orgs || state.orgs;

    const header = h('div', { class: 'page-header' },
      h('div', {},
        h('h2', { class: 'page-title' }, 'Projects'),
        h('p', { class: 'page-subtitle' }, 'Every project gets isolated credentials, its own databases, storage and auth users. Tenant isolation is enforced at the database and API layers.')),
      h('div', { class: 'page-actions' },
        h('button', { class: 'btn btn-secondary', onclick: () => showOrgsModal() }, icon('users'), 'Organization'),
        h('button', { class: 'btn btn-primary', onclick: () => showCreateModal(() => render(page)) }, icon('plus'), 'New project')));

    if (!state.projects.length) {
      page.append(header, emptyState({
        title: 'No projects yet',
        sub: 'Create your first project — Bloop provisions a default SQLite database, environments (dev/staging/prod) and API keys automatically.',
        icon: 'layers',
        action: h('button', { class: 'btn btn-primary', onclick: () => showCreateModal(() => render(page)) }, icon('plus'), 'Create project'),
      }));
      return;
    }

    const grid = h('div', { class: 'grid grid-3' });
    for (const p of state.projects) {
      grid.append(projectCard(p, () => render(page)));
    }

    page.append(header, grid);
  },
});

function projectCard(p, refresh) {
  const select = async () => {
    state.projectId = p.id;
    localStorage.setItem('bloop.projectId', p.id);
    const { refreshProject } = await import('./components.js');
    await refreshProject();
    const { renderSidebar } = await import('./sidebar.js');
    renderSidebar();
    go('overview');
  };
  return h('div', { class: 'card', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' } },
      h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', minWidth: '0' } },
        h('div', { class: 'tile-icon green', style: { width: '38px', height: '38px' } }, icon('layers')),
        h('div', { style: { minWidth: '0' } },
          h('div', { class: 'tile-title', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.name),
          h('div', { class: 'tile-sub mono', style: { fontSize: '11.5px' } }, p.slug))),
      h('button', { class: 'icon-btn', 'data-tip': 'Actions', onclick: (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        contextMenu([
          { label: 'Open', icon: 'external', onClick: select },
          { label: 'Duplicate…', icon: 'copy', onClick: () => showDuplicateModal(p, refresh) },
          { label: 'Export bundle', icon: 'download', onClick: () => exportProject(p) },
          { label: 'Import / migrate data…', icon: 'upload', onClick: () => showImportWizard(p) },
          { label: 'Environments', icon: 'branch', onClick: () => showEnvsModal(p) },
          '-',
          { label: 'Delete…', icon: 'trash', danger: true, onClick: () => showDeleteModal(p, refresh) },
        ], rect.left, rect.bottom + 4);
      } }, icon('more'))),
    h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      badge(p.status === 'active' ? 'ACTIVE' : p.status.toUpperCase(), p.status === 'active' ? 'green' : 'gray'),
      badge(`${p.environments?.length || 0} ENV`, 'outline'),
      badge(`${p.connections_count || 0} DB`, 'outline'),
      badge(`${p.keys_count || 0} KEYS`, 'outline')),
    h('div', { class: 'tile-sub', style: { minHeight: '32px' } }, p.description || 'No description'),
    h('div', { style: { display: 'flex', gap: '8px', marginTop: '4px' } },
      h('button', { class: 'btn btn-secondary btn-sm', style: { flex: '1' }, onclick: select }, 'Open'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => showEnvsModal(p) }, icon('branch'), 'Envs')),
    h('div', { class: 'cell-dim', style: { fontSize: '11.5px' } }, `Created ${fmtDate(p.created_at)}`));
}

function renderError(page, e) {
  page.append(h('div', { class: 'error-box' }, e.message));
}

/* ── Create / duplicate ── */
function showCreateModal(refresh) {
  const name = h('input', { class: 'input', placeholder: 'my-app' });
  const desc = h('input', { class: 'input', placeholder: 'What is this project for?' });
  const btn = h('button', { class: 'btn btn-primary' }, 'Create project');
  btn.addEventListener('click', async () => {
    if (name.value.trim().length < 2) return toastError('Project name needs at least 2 characters');
    btn.disabled = true;
    try {
      const project = await post('/api/admin/projects', { name: name.value.trim(), description: desc.value });
      toastSuccess(`Project “${project.name}” created — SQLite database, environments and API keys provisioned`);
      state.projectId = project.id;
      localStorage.setItem('bloop.projectId', project.id);
      m.close();
      refresh();
    } catch (e) { toastError(e); btn.disabled = false; }
  });
  const m = modal({
    title: 'New project',
    body: h('div', {},
      field('Project name', name, { hint: 'Also used to generate the project slug' }),
      field('Description (optional)', desc),
      h('div', { class: 'callout' }, 'Provisioned automatically: embedded SQLite database, dev/staging/prod environments, anon + service API keys, isolated storage directory.')),
    footer: btn,
  });
  name.focus();
}

function showDuplicateModal(p, refresh) {
  const name = h('input', { class: 'input', value: `${p.name} copy` });
  const m = modal({
    title: `Duplicate “${p.name}”`,
    body: h('div', {},
      field('New project name', name),
      h('div', { class: 'callout' }, 'Copies the project configuration, environments and (for SQLite) a full data snapshot. API keys are regenerated fresh.')),
    footer: h('button', { class: 'btn btn-primary', onclick: async () => {
      try {
        const created = await post(`/api/admin/projects/${p.id}/duplicate`, { name: name.value });
        toastSuccess(`Duplicated as “${created.name}”`);
        m.close(); refresh();
      } catch (e) { toastError(e); }
    } }, 'Duplicate'),
  });
}

async function exportProject(p) {
  try {
    const res = await fetch(`/api/admin/projects/${p.id}/export`, { headers: { Authorization: `Bearer ${localStorage.getItem('bloop.adminToken')}` } });
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const blob = await res.blob();
    const a = h('a', { href: URL.createObjectURL(blob), download: `${p.slug}-export.json` });
    a.click();
    toastSuccess('Project bundle exported (data + config)');
  } catch (e) { toastError(e); }
}

async function showDeleteModal(p, refresh) {
  const ok = await confirmDialog({
    title: `Delete “${p.name}”?`,
    message: 'This permanently removes the project, its databases, storage files, functions, keys and logs. This cannot be undone.',
    confirmText: 'Delete project',
    danger: true,
    requireText: p.name,
  });
  if (!ok) return;
  try {
    await post(`/api/admin/projects/${p.id}/delete`, { confirm: true });
    toastSuccess(`Project “${p.name}” deleted`);
    if (state.projectId === p.id) { state.projectId = null; localStorage.removeItem('bloop.projectId'); }
    refresh();
  } catch (e) { toastError(e); }
}

/* ── Environments ── */
function showEnvsModal(p) {
  const list = h('div', {});
  const renderList = async () => {
    clear(list);
    const { environments } = await get(`/api/admin/projects/${p.id}/environments`);
    for (const env of environments) {
      list.append(h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px', padding: '9px 4px', borderBottom: '1px solid var(--border)' } },
        icon('branch'),
        h('div', { style: { flex: '1' } },
          h('div', {}, h('span', { class: 'mono', style: { fontSize: '13px' } }, env.name), env.is_default ? badge('DEFAULT', 'green') : null),
          h('div', { class: 'menu-sub' }, env.cloned_from ? `cloned ${fmtDate(env.created_at)}` : fmtDate(env.created_at))),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
          const name = prompt('Clone as environment name:', `${env.name}-copy`);
          if (!name) return;
          try { await post(`/api/admin/projects/${p.id}/environments/${env.id}/clone`, { name }); toastSuccess('Environment cloned (vars + connections copied)'); renderList(); }
          catch (e) { toastError(e); }
        } }, 'Clone'),
        !env.is_default ? h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
          try { await post(`/api/admin/projects/${p.id}/environments/${env.id}/set-default`); renderList(); }
          catch (e) { toastError(e); }
        } }, 'Set default') : null,
        ['dev', 'staging', 'prod'].includes(env.name) ? null :
          h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
            try { await del(`/api/admin/projects/${p.id}/environments/${env.id}`); renderList(); }
            catch (e) { toastError(e); }
          } }, icon('trash'))));
    }
    const vars = environments[0] ? h('div', { style: { marginTop: '14px' } },
      h('div', { class: 'micro', style: { marginBottom: '8px' } }, `Environment variables — ${environments[0].name}`),
      await renderVars(p, environments[0])) : null;
    if (vars) list.append(vars);
  };
  modal({
    title: `Environments — ${p.name}`,
    size: 'modal-lg',
    body: h('div', {},
      list,
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px' } },
        (() => { const input = h('input', { class: 'input', placeholder: 'new-environment-name', style: { maxWidth: '220px' } });
          return h('div', { class: 'input-with-btn' }, input,
            h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => {
              try { await post(`/api/admin/projects/${p.id}/environments`, { name: input.value }); input.value = ''; renderList(); }
              catch (e) { toastError(e); }
            } }, icon('plus'), 'Add environment')); })())),
  });
  renderList();
}

async function renderVars(p, env) {
  const { vars } = await get(`/api/admin/projects/${p.id}/environments/${env.id}/vars`);
  const wrap = h('div', {});
  for (const v of vars) {
    wrap.append(h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px', padding: '5px 0' } },
      h('span', { class: 'mono' }, v.key),
      h('span', { class: 'cell-dim mono' }, v.value),
      h('button', { class: 'icon-btn', style: { marginLeft: 'auto' }, onclick: async () => {
        try { await del(`/api/admin/projects/${p.id}/environments/${env.id}/vars/${v.key}`); renderVarsInto(wrap, p, env); }
        catch (e) { toastError(e); }
      } }, icon('trash'))));
  }
  const key = h('input', { class: 'input mono', placeholder: 'KEY', style: { maxWidth: '160px' } });
  const value = h('input', { class: 'input mono', placeholder: 'value (stored encrypted)' });
  wrap.append(h('div', { class: 'input-with-btn', style: { marginTop: '8px' } },
    key, value,
    h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => {
      if (!key.value || !value.value) return toastError('Key and value required');
      try { await putVar(p, env, key.value, value.value); key.value = ''; value.value = ''; renderVarsInto(wrap, p, env); toastSuccess('Variable stored (encrypted at rest)'); }
      catch (e) { toastError(e); }
    } }, 'Set')));
  wrap.refreshInto = (target) => { clear(target); renderVarsInto(target, p, env); };
  return wrap;
}
async function renderVarsInto(target, p, env) {
  clear(target);
  target.append(await renderVars(p, env));
}
async function putVar(p, env, key, value) {
  return fetch(`/api/admin/projects/${p.id}/environments/${env.id}/vars`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('bloop.adminToken')}` },
    body: JSON.stringify({ key, value }),
  }).then((r) => r.json());
}

/* ── Organization / members / invites ── */
function showOrgsModal() {
  const body = h('div', {});
  const renderBody = async () => {
    clear(body);
    const orgs = (await get('/api/admin/orgs')).orgs;
    const org = orgs[0];
    if (!org) { body.append('No organization'); return; }
    body.append(h('div', { class: 'kv-list', style: { marginBottom: '16px' } },
      h('dt', {}, 'Organization'), h('dd', {}, org.name),
      h('dt', {}, 'Your role'), h('dd', {}, org.role),
      h('dt', {}, 'Projects'), h('dd', {}, String(org.projects_count ?? '—'))));
    body.append(h('div', { class: 'micro', style: { marginBottom: '8px' } }, 'Members'));
    const members = (await get(`/api/admin/orgs/${org.id}/members`)).members;
    const memberList = h('div', {});
    for (const mem of members) {
      memberList.append(h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px', padding: '6px 0', borderBottom: '1px solid var(--border)' } },
        h('div', { style: { flex: '1' } }, h('div', {}, mem.name || mem.email), h('div', { class: 'menu-sub' }, mem.email)),
        h('select', { class: 'input', style: { width: '120px' }, onchange: async (e) => {
          try { await patch(`/api/admin/orgs/${org.id}/members/${mem.user_id}`, { role: e.target.value }); toastSuccess('Role updated'); }
          catch (e2) { toastError(e2); renderBody(); }
        } }, ...['owner', 'admin', 'developer', 'viewer'].map((role) =>
          h('option', { value: role, selected: mem.role === role }, role))),
        members.length > 1 ? h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
          try { await del(`/api/admin/orgs/${org.id}/members/${mem.user_id}`); renderBody(); }
          catch (e) { toastError(e); }
        } }, icon('trash')) : null));
    }
    body.append(memberList);
    body.append(h('div', { class: 'micro', style: { margin: '16px 0 8px' } }, 'Invitations'));
    const invEmail = h('input', { class: 'input', placeholder: 'invite@example.com', style: { maxWidth: '200px' } });
    const invRole = h('select', { class: 'input', style: { width: '110px' } }, ...['admin', 'developer', 'viewer'].map((r2) => h('option', { value: r2 }, r2)));
    const invList = h('div', {});
    const renderInvites = async () => {
      clear(invList);
      const { invitations } = await get(`/api/admin/orgs/${org.id}/invitations`);
      for (const inv of invitations) {
        invList.append(h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px', padding: '5px 0' } },
          h('span', {}, inv.email), badge(inv.role.toUpperCase(), 'outline'), badge(inv.status.toUpperCase(), inv.status === 'pending' ? 'warn-badge' : 'gray'),
          h('span', { class: 'cell-dim', style: { marginLeft: 'auto', fontSize: '11.5px' } }, fmtDate(inv.expires_at)),
          inv.status === 'pending' ? h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => { await del(`/api/admin/orgs/${org.id}/invitations/${inv.id}`); renderInvites(); } }, 'Revoke') : null));
      }
    };
    body.append(h('div', { class: 'input-with-btn' }, invEmail, invRole,
      h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => {
        try {
          const inv = await post(`/api/admin/orgs/${org.id}/invitations`, { email: invEmail.value, role: invRole.value });
          toastSuccess(inv.emailed ? `Invitation emailed to ${inv.email}` : `Invitation created — token: ${inv.token.slice(0, 10)}… (SMTP not configured)`);
          renderInvites();
        } catch (e) { toastError(e); }
      } }, 'Invite')));
    body.append(invList);
    renderInvites();
  };
  modal({ title: 'Organization & members', body, size: 'modal-lg' });
  renderBody();
}

/* ── Import wizard ── */
async function showImportWizard(p) {
  const { sources } = await get('/api/admin/import/sources');
  let selected = sources[0];
  let jobId = null;
  let introspection = null;
  let mapping = null;

  const sourceSel = h('select', { class: 'input' }, ...sources.map((s) => h('option', { value: s.id }, s.name)));
  const configFields = h('div', {});
  const notes = h('div', { class: 'callout warn', style: { marginTop: '10px' } }, selected.notes);
  const result = h('div', {});
  const progressBar = h('div', { class: 'progress-bar', style: { display: 'none' } }, h('div', { style: { width: '0%' } }));

  function renderConfigFields() {
    clear(configFields);
    const required = selected.requiredConfig;
    const inputs = {};
    for (const key of required) {
      const isSecret = /password|key|account|secret/i.test(key);
      const input = h('input', { class: 'input mono', type: isSecret ? 'password' : 'text', placeholder: key, value: key === 'url' ? '' : '' });
      if (key === 'serviceAccountJson') {
        input.type = 'textarea';
        const ta = h('textarea', { class: 'input mono', placeholder: 'Paste the service-account JSON…', style: { minHeight: '90px' } });
        inputs[key] = ta;
        configFields.append(field(key, ta));
        continue;
      }
      inputs[key] = input;
      configFields.append(field(key, input, { hint: isSecret ? 'Stored encrypted; never returned in full' : null }));
    }
    configFields._inputs = inputs;
  }
  renderConfigFields();
  sourceSel.addEventListener('change', () => {
    selected = sources.find((s) => s.id === sourceSel.value);
    notes.textContent = selected.notes;
    renderConfigFields();
  });

  const stepIndicator = h('div', { class: 'micro', style: { margin: '8px 0' } }, 'Step 1 — connect & test');

  const btnTest = h('button', { class: 'btn btn-secondary', onclick: async () => {
    const config = collectConfig();
    if (!config) return;
    btnTest.disabled = true;
    try {
      const created = await post(`/api/admin/projects/${p.id}/import/jobs`, { source: selected.id, config });
      jobId = created.id;
      if (!created.connectionTest?.ok) {
        toastError(`Connection failed: ${created.connectionTest?.error}`);
        result.append(h('div', { class: 'error-box' }, created.connectionTest?.error || 'connection failed'));
        return;
      }
      toastSuccess('Connection OK');
      stepIndicator.textContent = 'Step 2 — introspect source';
      btnIntrospect.style.display = '';
    } catch (e) { toastError(e); }
    btnTest.disabled = false;
  } }, '1. Test connection');

  const btnIntrospect = h('button', { class: 'btn btn-secondary', style: { display: 'none' }, onclick: async () => {
    btnIntrospect.disabled = true;
    try {
      const data = await post(`/api/admin/import/jobs/${jobId}/introspect${p.id ? `?projectId=${p.id}` : ''}`);
      introspection = data.introspection;
      mapping = data.mapping;
      clear(result);
      result.append(
        h('div', { class: 'micro', style: { margin: '10px 0 6px' } }, 'Discovered source objects'),
        h('div', { class: 'json-view', style: { maxHeight: '160px' } }, JSON.stringify(introspection, null, 2)),
        h('div', { class: 'micro', style: { margin: '12px 0 6px' } }, 'Planned mapping'),
        h('div', { class: 'json-view', style: { maxHeight: '220px' } }, JSON.stringify(mapping, null, 2)),
        h('div', { class: 'callout', style: { marginTop: '10px' } }, mapping.unsupported?.length ? `Imported with known gaps: ${mapping.unsupported.join(' · ')}` : 'No known gaps'));
      stepIndicator.textContent = 'Step 3 — review preview, then run';
      btnRun.style.display = '';
    } catch (e) { toastError(e); }
    btnIntrospect.disabled = false;
  } }, '2. Introspect & preview');

  const btnRun = h('button', { class: 'btn btn-primary', style: { display: 'none' }, onclick: async () => {
    const ok = await confirmDialog({
      title: 'Run import?',
      message: 'Data is copied into this project. Source data is never modified. Rows that fail validation are skipped and reported.',
      confirmText: 'Start import',
    });
    if (!ok) return;
    btnRun.disabled = true;
    progressBar.style.display = '';
    await post(`/api/admin/import/jobs/${jobId}/run?projectId=${p.id}`);
    pollStatus();
  } }, '3. Run import');

  const poll = setInterval(() => { if (jobId && btnRun.disabled) pollStatus(); }, 1500);
  async function pollStatus() {
    try {
      const job = await get(`/api/admin/import/jobs/${jobId}/status?projectId=${p.id}`);
      const steps = job.progress?.steps || [];
      progressBar.firstChild.style.width = `${Math.min(95, steps.length * 12)}%`;
      if (['completed', 'failed'].includes(job.status)) {
        clearInterval(poll);
        progressBar.style.display = 'none';
        btnRun.disabled = false;
        if (job.status === 'completed') {
          const s = job.summary || {};
          clear(result);
          result.append(h('div', { class: 'callout green' },
            `Import finished — ${s.tables || 0} tables, ${s.collections || 0} collections, ${fmtNumber(s.rows || 0)} rows, ${s.users || 0} users.`,
            s.errors?.length ? h('div', { style: { marginTop: '8px' } }, `${s.errors.length} item(s) were skipped:`) : null,
            s.errors?.length ? h('div', { class: 'json-view', style: { maxHeight: '140px', marginTop: '6px' } }, JSON.stringify(s.errors, null, 2)) : null,
            h('div', { style: { marginTop: '8px', fontSize: '12px' } }, s.unsupported || '')));
          stepIndicator.textContent = 'Done';
        } else {
          result.append(h('div', { class: 'error-box' }, job.error || 'import failed'));
        }
      }
    } catch { /* keep polling */ }
  }

  function collectConfig() {
    const inputs = configFields._inputs || {};
    const config = {};
    for (const [k, input] of Object.entries(inputs)) {
      const v = input.value?.trim();
      if (!v) { toastError(`Field "${k}" is required`); return null; }
      config[k] = v;
    }
    return config;
  }

  const m = modal({
    title: `Import / migrate into “${p.name}”`,
    size: 'modal-xl',
    onClose: () => clearInterval(poll),
    body: h('div', {},
      h('div', { class: 'grid grid-2' },
        h('div', {},
          field('Source platform', sourceSel),
          configFields,
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' } }, btnTest, btnIntrospect, btnRun)),
        h('div', {},
          notes, stepIndicator, progressBar, result))),
  });
}
