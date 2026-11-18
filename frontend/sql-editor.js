// sql-editor.js — SQL Studio: tabbed editor with syntax highlighting,
// autocomplete, formatting, explain, transactions, saved queries, history,
// export and a real results grid.
import {
  h, clear, get, post, icon, state, toast, toastSuccess, toastError, modal,
  field, emptyState, requireProject, fmtNumber, highlightSql, safeParse,
  contextMenu, badge, fmtDate, dataTable,
} from './components.js';
import { register } from './router.js';

const editorState = {
  catalog: null,       // { tables, keywords } for autocomplete
  tabs: [],            // [{id, name, sql}]
  activeTab: null,
  sessionId: null,
};

register('sql', {
  title: 'SQL Editor',
  async render(page) {
    if (!requireProject(page, 'SQL Editor')) return;
    const { connections } = await get(`/api/admin/projects/${state.projectId}/connections`);
    if (!connections.length) {
      page.append(emptyState({ title: 'No database connection', sub: 'Add a connection in the Database page first.', icon: 'database', action: h('button', { class: 'btn btn-primary', onclick: () => location.hash = '#/database' }, 'Go to Database') }));
      return;
    }
    const connSel = h('select', { class: 'input', style: { maxWidth: '240px' } },
      ...connections.map((c) => h('option', { value: c.id, selected: c.is_default }, `${c.name} (${c.provider})`)));
    const { history } = await get(`/api/admin/projects/${state.projectId}/query-history?limit=30`);

    if (!editorState.tabs.length) {
      editorState.tabs = [{ id: 't1', name: 'Query 1', sql: '-- Ctrl+Enter to run · Ctrl+Space for autocomplete\nSELECT name FROM sqlite_master WHERE type = \'table\' ORDER BY name;\n' }];
      editorState.activeTab = 't1';
    }

    const tabBar = h('div', { class: 'tabs', style: { marginBottom: '0' } });
    const toolbar = h('div', { class: 'editor-toolbar' });
    const editorBody = h('div', { class: 'editor-body' });
    const highlight = h('pre', { class: 'editor-highlight', 'aria-hidden': 'true' });
    const textarea = h('textarea', { class: 'editor-textarea', spellcheck: 'false', placeholder: 'Write SQL…' });
    editorBody.append(highlight, textarea);
    const results = h('div', { style: { marginTop: '12px' } });

    /* ── tabs ── */
    function renderTabs() {
      clear(tabBar);
      for (const t of editorState.tabs) {
        tabBar.append(h('button', {
          class: `tab ${t.id === editorState.activeTab ? 'active' : ''}`,
          onclick: () => { editorState.activeTab = t.id; loadTab(); renderTabs(); },
        }, t.name,
        h('span', { class: 'close-x', onclick: (e) => { e.stopPropagation(); closeTab(t.id); } }, '×')));
      }
      tabBar.append(h('button', { class: 'tab', 'data-tip': 'New tab', onclick: () => {
        const id = 't' + Date.now();
        editorState.tabs.push({ id, name: `Query ${editorState.tabs.length + 1}`, sql: '' });
        editorState.activeTab = id; loadTab(); renderTabs();
      } }, icon('plus')));
    }
    function closeTab(id) {
      editorState.tabs = editorState.tabs.filter((t) => t.id !== id);
      if (!editorState.tabs.length) editorState.tabs = [{ id: 't' + Date.now(), name: 'Query 1', sql: '' }];
      if (!editorState.tabs.find((t) => t.id === editorState.activeTab)) editorState.activeTab = editorState.tabs[0].id;
      loadTab(); renderTabs();
    }
    function active() { return editorState.tabs.find((t) => t.id === editorState.activeTab); }
    function loadTab() {
      textarea.value = active()?.sql || '';
      syncHighlight();
    }
    function syncHighlight() {
      const t = active();
      if (t) t.sql = textarea.value;
      highlight.innerHTML = highlightSql(textarea.value) + '\n';
      highlight.style.minHeight = textarea.style.height || '';
      highlight.scrollTop = textarea.scrollTop;
    }
    renderTabs();

    textarea.addEventListener('input', syncHighlight);
    textarea.addEventListener('scroll', () => { highlight.scrollTop = textarea.scrollTop; });
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runQuery(); }
      if (e.ctrlKey && e.key === ' ') { e.preventDefault(); openAutocomplete(); }
      if (e.key === 'Tab') { e.preventDefault(); insertAtCaret('  '); }
    });

    function insertAtCaret(text) {
      const start = textarea.selectionStart, end = textarea.selectionEnd;
      textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
      textarea.selectionStart = textarea.selectionEnd = start + text.length;
      syncHighlight();
    }

    /* ── autocomplete ── */
    let acMenu = null;
    async function ensureCatalog() {
      if (!editorState.catalog) {
        try { editorState.catalog = await get(`/api/admin/connections/${connSel.value}/autocomplete`); }
        catch { editorState.catalog = { tables: [], keywords: [] }; }
      }
      return editorState.catalog;
    }
    connSel.addEventListener('change', () => { editorState.catalog = null; });

    async function openAutocomplete() {
      const catalog = await ensureCatalog();
      const caret = textarea.selectionStart;
      const before = textarea.value.slice(0, caret);
      const word = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(before)?.[1] || '';
      const candidates = [
        ...catalog.tables.flatMap((t) => [{ label: t.name, kind: 'table' }, ...t.columns.map((c) => ({ label: `${t.name}.${c.name}`, kind: 'column' }))]),
        ...catalog.keywords.map((k) => ({ label: k, kind: 'keyword' })),
      ].filter((c) => c.label.toLowerCase().startsWith(word.toLowerCase()) && word !== c.label).slice(0, 12);
      if (!candidates.length) return;
      acMenu?.remove();
      let selected = 0;
      acMenu = h('div', { class: 'ac-menu', style: { position: 'absolute' } });
      const place = () => {
        const rect = textarea.getBoundingClientRect();
        const shellRect = editorBody.getBoundingClientRect();
        acMenu.style.left = `${Math.min(rect.width - 260, 16 + (caret % 80) * 7)}px`;
        acMenu.style.top = `${Math.min(shellRect.height - 180, 30 + (before.split('\n').length - 1) * 20 - textarea.scrollTop)}px`;
      };
      const renderItems = () => {
        clear(acMenu);
        candidates.forEach((c, i) => acMenu.append(h('div', {
          class: `ac-item ${i === selected ? 'selected' : ''}`,
          onclick: () => accept(c),
        }, c.label, h('span', { class: 'ac-kind' }, c.kind))));
      };
      const accept = (c) => {
        const full = c.label.slice(word.length);
        insertAtCaret(full);
        acMenu?.remove(); acMenu = null;
        textarea.focus();
      };
      const onKey = (e) => {
        if (!acMenu) return;
        if (e.key === 'ArrowDown') { selected = Math.min(selected + 1, candidates.length - 1); renderItems(); e.preventDefault(); e.stopPropagation(); }
        else if (e.key === 'ArrowUp') { selected = Math.max(selected - 1, 0); renderItems(); e.preventDefault(); e.stopPropagation(); }
        else if (e.key === 'Enter' || e.key === 'Tab') { accept(candidates[selected]); e.preventDefault(); e.stopPropagation(); }
        else if (e.key === 'Escape') { acMenu.remove(); acMenu = null; }
      };
      textarea.addEventListener('keydown', onKey, { capture: true });
      const observer = new MutationObserver(() => {
        if (!document.contains(acMenu)) { textarea.removeEventListener('keydown', onKey, true); observer.disconnect(); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      renderItems(); place();
      editorBody.append(acMenu);
    }

    /* ── run ── */
    async function runQuery() {
      const sql = textarea.value.trim();
      if (!sql) return;
      clear(results).append(h('div', { class: 'loading-block' }, h('div', { class: 'spinner' }), 'Executing…'));
      const t0 = performance.now();
      try {
        const data = await post(`/api/admin/connections/${connSel.value}/query`, { sql, sessionId: editorState.sessionId || undefined });
        renderResults(data, performance.now() - t0);
      } catch (e) {
        clear(results).append(h('div', { class: 'error-box' }, `${e.message}`));
      }
    }

    function renderResults(data, clientMs) {
      clear(results);
      const total = h('div', { class: 'results-meta' },
        h('span', { class: data.results.every((r) => r.status === 'ok') ? 'ok' : 'err' },
          `${data.results.length} statement(s) · total ${data.totalMs}ms (client ${Math.round(clientMs)}ms)`),
        h('span', { style: { marginLeft: 'auto' }, class: 'mono' }, `history saved ✓`));
      results.append(total);
      data.results.forEach((r, i) => {
        const wrap = h('div', { style: { marginTop: '10px' } });
        wrap.append(h('div', { class: 'results-meta' },
          h('span', { class: 'micro' }, `#${i + 1} · ${r.sql.slice(0, 60)}${r.sql.length > 60 ? '…' : ''}`),
          r.status === 'ok'
            ? h('span', { class: 'ok' }, `✓ ${fmtNumber(r.rowCount)} rows · ${r.durationMs}ms`)
            : h('span', { class: 'err' }, `✗ ${r.error}`),
          r.status === 'ok' && r.rows.length ? h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
            exportBtn('CSV', r), exportBtn('JSON', r)) : null));
        if (r.status !== 'ok') { wrap.append(h('div', { class: 'error-box' }, r.error)); results.append(wrap); return; }
        if (!r.rows.length) { wrap.append(h('div', { class: 'cell-dim', style: { padding: '10px 2px' } }, r.rowCount === 0 ? 'No rows returned.' : 'Statement executed.')); results.append(wrap); return; }
        const cols = (r.columns && r.columns.length ? r.columns : Object.keys(r.rows[0])).map((key) => ({
          key, label: key,
          render: (row) => {
            const v = row[key];
            if (v === null) return h('span', { class: 'cell-dim' }, 'NULL');
            if (typeof v === 'object') return h('span', { class: 'cell-mono cell-dim' }, JSON.stringify(v).slice(0, 70));
            return String(v).slice(0, 120);
          },
        }));
        wrap.append(dataTable({
          columns: cols,
          rows: r.rows.slice(0, 300),
          emptyTitle: 'No rows',
        }));
        results.append(wrap);
      });
    }
    function exportBtn(format, r) {
      return h('button', { class: 'btn btn-ghost btn-sm', onclick: () => {
        const blob = format === 'csv'
          ? new Blob([toCsv(r.rows)], { type: 'text/csv' })
          : new Blob([JSON.stringify(r.rows, null, 2)], { type: 'application/json' });
        const a = h('a', { href: URL.createObjectURL(blob), download: `result-${Date.now()}.${format.toLowerCase()}` });
        a.click();
      } }, `↓ ${format}`);
    }
    function toCsv(rows) {
      if (!rows.length) return '';
      const cols = Object.keys(rows[0]);
      const esc = (v) => v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/"/g, '""');
      return [cols.join(','), ...rows.map((r) => cols.map((c) => /[",\n]/.test(String(r[c])) ? `"${esc(r[c])}"` : esc(r[c])).join(','))].join('\n');
    }

    /* ── toolbar ── */
    const btnRun = h('button', { class: 'btn btn-primary btn-sm', 'data-role': 'save-btn', onclick: runQuery }, icon('play'), 'Run  (Ctrl+↵)');
    const btnFormat = h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
      textarea.value = await formatSql(textarea.value);
      syncHighlight();
    } }, 'Format');
    const btnExplain = h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
      try {
        const r = await post(`/api/admin/connections/${connSel.value}/explain`, { sql: textarea.value });
        modal({ title: 'Query plan', size: 'modal-lg', body: jsonViewSafe(r) });
      } catch (e) { toastError(e); }
    } }, 'Explain');
    const btnSave = h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
      const name = prompt('Save query as:', 'my query');
      if (!name) return;
      try { await post(`/api/admin/projects/${state.projectId}/saved-queries`, { name, sql: textarea.value, connectionId: connSel.value }); toastSuccess('Query saved'); }
      catch (e) { toastError(e); }
    } }, icon('save'), 'Save');
    const btnTx = h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
      try {
        const r = await post(`/api/admin/connections/${connSel.value}/transactions/begin`);
        editorState.sessionId = r.sessionId;
        toastSuccess(`Transaction session started (${r.provider}) — statements now run inside it`);
      } catch (e) { toastError(e); }
    } }, 'BEGIN');
    const btnCommit = h('button', { class: 'btn btn-ghost btn-sm', disabled: !editorState.sessionId, onclick: async () => {
      try { await post(`/api/admin/transactions/${editorState.sessionId}/commit`); editorState.sessionId = null; toastSuccess('Transaction committed'); btnCommit.disabled = true; btnRollback.disabled = true; }
      catch (e) { toastError(e); }
    } }, 'COMMIT');
    const btnRollback = h('button', { class: 'btn btn-ghost btn-sm', disabled: !editorState.sessionId, onclick: async () => {
      try { await post(`/api/admin/transactions/${editorState.sessionId}/rollback`); editorState.sessionId = null; toastSuccess('Transaction rolled back'); btnCommit.disabled = true; btnRollback.disabled = true; }
      catch (e) { toastError(e); }
    } }, 'ROLLBACK');
    const btnHistory = h('button', { class: 'btn btn-ghost btn-sm', onclick: () => {
      const historyBody = history.length
        ? h('div', {}, ...history.map((q) => {
          const head = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            badge(q.status === 'ok' ? 'OK' : 'ERR', q.status === 'ok' ? 'green' : 'red'),
            h('span', { class: 'cell-dim', style: { fontSize: '11.5px' } }, `${q.duration_ms}ms · ${fmtDate(q.created_at)}`),
            h('button', { class: 'btn btn-ghost btn-sm', style: { marginLeft: 'auto' }, onclick: () => { textarea.value = q.sql; syncHighlight(); document.querySelector('.modal-overlay')?.remove(); } }, 'Load'));
          const pre = h('pre', { class: 'mono', style: { fontSize: '11.5px', color: 'var(--text-muted)', maxHeight: '60px', overflow: 'hidden', margin: '4px 0 0' } }, q.sql);
          return h('div', { style: { borderBottom: '1px solid var(--border)', padding: '8px 0' } }, head, pre);
        }))
        : emptyState({ title: 'No history yet', icon: 'clock' });
      modal({ title: 'Query history (latest 30)', size: 'modal-lg', body: historyBody });
    } }, icon('clock'), 'History');
    const btnSaved = h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
      const { queries } = await get(`/api/admin/projects/${state.projectId}/saved-queries`);
      const savedBody = queries.length
        ? h('div', {}, ...queries.map((q) => {
          const label = h('div', { style: { flex: '1', minWidth: '0' } },
            h('div', {}, q.name),
            h('div', { class: 'cell-dim mono', style: { fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, q.sql));
          const loadBtn = h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { textarea.value = q.sql; syncHighlight(); document.querySelector('.modal-overlay')?.remove(); } }, 'Load');
          const delBtn = h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
            const { del } = await import('./components.js');
            await del(`/api/admin/projects/${state.projectId}/saved-queries/${q.id}`);
            toastSuccess('Deleted');
            document.querySelector('.modal-overlay')?.remove();
            btnSaved.click();
          } }, icon('trash'));
          return h('div', { style: { borderBottom: '1px solid var(--border)', padding: '9px 0', display: 'flex', alignItems: 'center', gap: '9px' } }, label, loadBtn, delBtn);
        }))
        : emptyState({ title: 'No saved queries', icon: 'save' });
      modal({ title: 'Saved queries', size: 'modal-lg', body: savedBody });
    } }, icon('save'), 'Saved');

    toolbar.append(connSel, btnRun, btnFormat, btnExplain, btnSave, btnHistory, btnSaved,
      h('span', { style: { flex: '1' } }), btnTx, btnCommit, btnRollback);

    async function formatSql(sql) {
      // client-side formatter matching the server's keyword style
      const keywords = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'ORDER BY', 'GROUP BY', 'HAVING', 'LIMIT', 'OFFSET', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'ON', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'UNION ALL', 'UNION'];
      let out = sql.replace(/\s+/g, ' ').trim();
      for (const kw of keywords) {
        out = out.replace(new RegExp(`\\s*${kw.replace(/ /g, '\\s+')}\\s+`, 'gi'), `\n${kw} `);
      }
      out = out.replace(/,\s*/g, ',\n  ');
      return out.split('\n').map((line, i) => (i === 0 ? line : /^(AND|OR|ON|SET)\b/i.test(line) ? '  ' + line : line)).join('\n');
    }

    function jsonViewSafe(data) {
      const pre = h('div', { class: 'json-view', style: { maxHeight: '420px' } });
      pre.textContent = JSON.stringify(data, null, 2);
      return pre;
    }

    page.append(
      h('div', { class: 'page-header' },
        h('div', {},
          h('h2', { class: 'page-title' }, 'SQL Editor'),
          h('p', { class: 'page-subtitle' }, 'Real SQL against the selected provider — multiple tabs, history, saved queries, transactions and query plans.'))),
      h('div', { class: 'editor-shell' }, tabBar, toolbar, editorBody),
      results);
    loadTab();
    textarea.focus();
  },
});
