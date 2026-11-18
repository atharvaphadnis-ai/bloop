// nosql-editor.js — NoSQL Explorer: collection list, document browser with
// filters/sort/pagination, JSON document editor, aggregation pipeline runner,
// index management, import/export. Works against the embedded document store
// or a real MongoDB connection (mode is reported honestly).
import {
  h, clear, get, post, del, icon, state, toast, toastSuccess, toastError,
  modal, field, emptyState, requireProject, fmtNumber, fmtDate, jsonView,
  safeParse, badge, dataTable, confirmDialog, contextMenu,
} from './components.js';
import { register } from './router.js';

let activeCollection = null;

register('nosql', {
  title: 'NoSQL Explorer',
  async render(page) {
    if (!requireProject(page, 'NoSQL Explorer')) return;
    const mode = await get(`/api/admin/projects/${state.projectId}/nosql/mode`);
    const layout = h('div', { class: 'split' });
    const pane = h('div', { class: 'list-pane' });
    const detail = h('div', { style: { minWidth: '0' } });
    layout.append(pane, detail);
    page.append(
      h('div', { class: 'page-header' },
        h('div', {},
          h('h2', { class: 'page-title' }, 'NoSQL Explorer'),
          h('p', { class: 'page-subtitle' }, `Mode: ${mode.mode === 'mongodb' ? 'MongoDB (passthrough — real indexes & aggregation)' : 'embedded document store (SQLite-backed) — Mongo-style filters evaluated in-process, in-memory aggregation'}`)),
        h('div', { class: 'page-actions' },
          h('button', { class: 'btn btn-secondary', onclick: () => showAggregationModal() }, icon('chart'), 'Aggregation'),
          h('button', { class: 'btn btn-primary', onclick: async () => {
            const name = prompt('New collection name:');
            if (!name) return;
            try { await post(`/api/admin/projects/${state.projectId}/nosql/collections`, { name }); toastSuccess(`Collection “${name}” created`); renderCollections(); }
            catch (e) { toastError(e); }
          } }, icon('plus'), 'New collection'))),
      layout);

    async function renderCollections() {
      clear(pane);
      const { collections } = await get(`/api/admin/projects/${state.projectId}/nosql/collections`);
      if (!collections.length) {
        pane.append(h('div', { style: { padding: '16px', color: 'var(--text-faint)' } }, 'No collections'));
        return;
      }
      if (!activeCollection || !collections.find((c) => c.name === activeCollection)) activeCollection = collections[0].name;
      for (const c of collections) {
        pane.append(h('button', { class: `list-pane-item ${c.name === activeCollection ? 'active' : ''}`, onclick: () => {
          activeCollection = c.name;
          renderCollections();
        } }, icon('braces'), h('span', {}, c.name),
        h('span', { class: 'cell-dim', style: { marginLeft: 'auto', fontSize: '11px' } }, fmtNumber(c.documents ?? '·'))));
      }
      renderDetail();
    }

    function renderDetail() {
      clear(detail);
      let page_ = 1;
      const pageSize = 25;
      const filterInput = h('textarea', { class: 'input mono', placeholder: '{"status": "active", "age": {"$gte": 18}}', style: { minHeight: '56px', maxWidth: '420px' } });
      const sortInput = h('input', { class: 'input mono', placeholder: 'createdAt:desc', style: { width: '160px' } });
      const container = h('div', {});

      async function load() {
        clear(container).append(h('div', { class: 'loading-block' }, h('div', { class: 'spinner' }), 'Querying…'));
        try {
          const filter = safeParse(filterInput.value || '{}', null);
          if (filter === null) throw new Error('Filter is not valid JSON');
          const [sortCol, sortDir] = (sortInput.value || '').split(':').map((s) => s.trim());
          const body = { filter, limit: pageSize, skip: (page_ - 1) * pageSize };
          if (sortCol) body.sort = { [sortCol]: sortDir === 'desc' ? 'desc' : 'asc' };
          const data = await post(`/api/admin/projects/${state.projectId}/nosql/${activeCollection}/find`, body);
          clear(container);
          const docs = data.documents || [];
          if (!docs.length) {
            container.append(emptyState({
              title: 'No documents match',
              sub: 'Insert documents with the button above, or loosen the filter.',
              icon: 'braces',
              action: h('button', { class: 'btn btn-secondary', onclick: () => showDocEditor(null) }, icon('plus'), 'Insert document'),
            }));
            return;
          }
          const total = data.total ?? docs.length;
          container.append(dataTable({
            columns: [
              { key: '_id', label: '_id', className: 'cell-mono' },
              { key: '_doc', label: 'document', render: (d) => {
                const copy = { ...d }; delete copy._doc;
                const s = JSON.stringify(copy);
                return h('span', { class: 'cell-mono', style: { fontSize: '12px' } }, s.slice(0, 110) + (s.length > 110 ? '…' : ''));
              } },
              { key: '_createdAt', label: 'created', render: (d) => h('span', { class: 'cell-dim' }, fmtDate(d._createdAt || d.createdAt || null)) },
            ],
            rows: docs.map((d) => ({ ...d, _doc: true })),
            onRowClick: (doc) => showDocEditor(doc),
            rowActions: (doc) => [
              h('button', { class: 'btn btn-ghost btn-sm', onclick: (e) => { e.stopPropagation(); showDocEditor(doc); } }, icon('edit')),
              h('button', { class: 'btn btn-ghost btn-sm', onclick: async (e) => {
                e.stopPropagation();
                const ok = await confirmDialog({ title: 'Delete document?', message: `Document ${doc._id} will be removed.`, confirmText: 'Delete', danger: true });
                if (!ok) return;
                try { await post(`/api/admin/projects/${state.projectId}/nosql/${activeCollection}/delete`, { filter: { _id: doc._id }, many: false }); toastSuccess('Document deleted'); load(); }
                catch (err) { toastError(err); }
              } }, icon('trash')),
            ],
            footer: () => h('div', { class: 'table-footer' },
              h('span', {}, `${fmtNumber(total)} documents · page ${page_}/${Math.max(1, Math.ceil(total / pageSize))}`),
              h('div', { style: { display: 'flex', gap: '6px' } },
                h('button', { class: 'btn btn-ghost btn-sm', disabled: page_ <= 1, onclick: () => { page_--; load(); } }, '←'),
                h('button', { class: 'btn btn-ghost btn-sm', disabled: page_ >= Math.ceil(total / pageSize), onclick: () => { page_++; load(); } }, '→'))),
          }));
        } catch (e) {
          clear(container);
          container.append(h('div', { class: 'error-box' }, e.message));
        }
      }

      function showDocEditor(doc) {
        const isNew = !doc;
        const editable = { ...(doc || {}) };
        delete editable._doc;
        const ta = h('textarea', { class: 'input mono', style: { minHeight: '260px' } });
        ta.value = JSON.stringify(editable, null, 2);
        modal({
          title: isNew ? `Insert into “${activeCollection}”` : `Edit document ${doc._id}`,
          size: 'modal-lg',
          body: h('div', {},
            field('Document JSON', ta, { hint: isNew ? 'A fresh _id is generated server-side' : 'Version history is kept on the embedded store' }),
            !isNew && mode.mode === 'embedded' ? h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
              const hist = await get(`/api/admin/projects/${state.projectId}/nosql/${activeCollection}/history/${doc._id}`);
              modal({ title: 'Document history', body: hist.versions?.length ? jsonView(hist.versions) : h('div', { class: 'cell-dim' }, 'No prior versions') });
            } }, icon('clock'), 'History') : null),
          footer: h('button', { class: 'btn btn-primary', onclick: async () => {
            const parsed = safeParse(ta.value, null);
            if (parsed === null) return toastError('Invalid JSON');
            try {
              if (isNew) {
                await post(`/api/admin/projects/${state.projectId}/nosql/${activeCollection}/insert`, parsed);
                toastSuccess('Document inserted');
              } else {
                const { _id, _createdAt, _updatedAt, _version, ...rest } = parsed;
                await post(`/api/admin/projects/${state.projectId}/nosql/${activeCollection}/update`, { filter: { _id: doc._id }, update: rest, many: false });
                toastSuccess('Document updated');
              }
              m.close(); load(); renderCollections();
            } catch (e) { toastError(e); }
          } }, isNew ? 'Insert document' : 'Save document'),
        });
      }

      detail.append(
        h('div', { class: 'card-header' },
          h('div', {},
            h('div', { class: 'card-title' }, activeCollection),
            h('div', { class: 'card-sub' }, mode.mode === 'mongodb' ? 'MongoDB passthrough' : 'embedded document store')),
          h('div', { style: { display: 'flex', gap: '6px' } },
            h('button', { class: 'btn btn-secondary btn-sm', onclick: () => showDocEditor(null) }, icon('plus'), 'Insert'),
            h('button', { class: 'btn btn-ghost btn-sm', onclick: () => showImportModal(load) }, icon('upload'), 'Import'),
            h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
              const res = await fetch(`/api/admin/projects/${state.projectId}/nosql/${activeCollection}/export`, { headers: { Authorization: `Bearer ${localStorage.getItem('bloop.adminToken')}` } });
              const blob = await res.blob();
              const a = h('a', { href: URL.createObjectURL(blob), download: `${activeCollection}.json` }); a.click();
            } }, icon('download'), 'Export'),
            h('button', { class: 'btn btn-ghost btn-sm', onclick: () => showIndexesModal() }, icon('list'), 'Indexes'),
            h('button', { class: 'btn btn-danger btn-sm', onclick: async () => {
              const ok = await confirmDialog({ title: `Drop collection “${activeCollection}”?`, message: 'All documents are removed.', confirmText: 'Drop collection', danger: true, requireText: activeCollection });
              if (!ok) return;
              try { await del(`/api/admin/projects/${state.projectId}/nosql/collections/${activeCollection}`, { confirm: true }); toastSuccess('Collection dropped'); activeCollection = null; renderCollections(); }
              catch (e) { toastError(e); }
            } }, icon('trash')))),
        h('div', { class: 'table-toolbar' },
          filterInput,
          sortInput,
          h('button', { class: 'btn btn-primary btn-sm', onclick: () => { page_ = 1; load(); } }, icon('search'), 'Query'),
          h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { filterInput.value = ''; sortInput.value = ''; page_ = 1; load(); } }, 'Reset')),
        container);

      load();
    }

    function showImportModal(refresh) {
      const ta = h('textarea', { class: 'input mono', style: { minHeight: '180px' }, placeholder: '[ { "name": "Ada" }, { "name": "Grace" } ]' });
      const m = modal({
        title: `Import JSON into “${activeCollection}”`,
        body: field('Documents (JSON array)', ta),
        footer: h('button', { class: 'btn btn-primary', onclick: async () => {
          const docs = safeParse(ta.value, null);
          if (!Array.isArray(docs)) return toastError('Paste a JSON array of documents');
          try {
            const r = await post(`/api/admin/projects/${state.projectId}/nosql/${activeCollection}/import`, { documents: docs });
            toastSuccess(`Imported ${r.imported} documents`); m.close(); refresh?.();
          } catch (e) { toastError(e); }
        } }, 'Import'),
      });
    }

    function showIndexesModal() {
      modal({
        title: `Indexes — ${activeCollection}`,
        size: 'modal-lg',
        body: (() => {
          const wrap = h('div', {});
          const renderIdx = async () => {
            clear(wrap);
            const { indexes } = await get(`/api/admin/projects/${state.projectId}/nosql/${activeCollection}/indexes`);
            for (const idx of indexes || []) {
              wrap.append(h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px', padding: '6px 0', borderBottom: '1px solid var(--border)' } },
                h('span', { class: 'cell-mono', style: { flex: '1' } }, idx.name),
                idx.unique ? badge('UNIQUE', 'outline') : null,
                h('span', { class: 'cell-dim mono', style: { fontSize: '11px' } }, JSON.stringify(idx.keys || idx.columns || {})),
                h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
                  await del(`/api/admin/projects/${state.projectId}/nosql/${activeCollection}/indexes/${idx.name}`);
                  toastSuccess('Index dropped'); renderIdx();
                } }, icon('trash'))));
            }
            const keys = h('input', { class: 'input mono', placeholder: '{"email": 1}', style: { maxWidth: '220px' } });
            const uniq = h('input', { type: 'checkbox' });
            wrap.append(h('div', { class: 'input-with-btn', style: { marginTop: '10px' } },
              keys,
              h('label', { class: 'checkbox-row', style: { whiteSpace: 'nowrap' } }, uniq, 'unique'),
              h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => {
                const spec = safeParse(keys.value, null);
                if (!spec) return toastError('Keys must be JSON like {"field": 1}');
                try {
                  const r = await post(`/api/admin/projects/${state.projectId}/nosql/${activeCollection}/indexes`, { keys: spec, unique: uniq.checked });
                  toastSuccess(r.note || 'Index created'); renderIdx();
                } catch (e) { toastError(e); }
              } }, 'Create')));
          };
          renderIdx();
          return wrap;
        })(),
      });
    }

    function showAggregationModal() {
      const collSel = h('input', { class: 'input mono', value: activeCollection || '', placeholder: 'collection' });
      const ta = h('textarea', { class: 'input mono', style: { minHeight: '160px' }, placeholder: '[\n  { "$match": { "status": "active" } },\n  { "$group": { "_id": "$country", "total": { "$sum": "$amount" } } },\n  { "$sort": { "total": -1 } }\n]' });
      const out = h('div', {});
      modal({
        title: 'Aggregation pipeline',
        size: 'modal-lg',
        body: h('div', {},
          field('Collection', collSel),
          field('Pipeline (JSON array)', ta, { hint: 'Embedded store supports $match, $group, $sort, $limit, $skip, $project, $count, $unwind. MongoDB passthrough supports everything MongoDB does.' }),
          h('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
            const pipeline = safeParse(ta.value, null);
            if (!Array.isArray(pipeline)) return toastError('Pipeline must be a JSON array');
            try {
              const r = await post(`/api/admin/projects/${state.projectId}/nosql/${collSel.value}/aggregate`, { pipeline });
              clear(out).append(jsonView(r.results));
            } catch (e) { clear(out).append(h('div', { class: 'error-box' }, e.message)); }
          } }, 'Run pipeline'),
          h('div', { style: { marginTop: '12px' } }, out)),
      });
    }

    renderCollections();
  },
});
