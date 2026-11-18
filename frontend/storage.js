// storage.js — Storage page: buckets, object browser, upload (drag & drop),
// signed URLs, access policy editing, S3 provider config, usage stats.
import {
  h, clear, get, post, patch, del, icon, state, toast, toastSuccess, toastError,
  modal, field, formRow, emptyState, requireProject, badge, fmtBytes, fmtDate,
  dataTable, confirmDialog, copyChip, fmtNumber, checkboxRow,
} from './components.js';
import { register } from './router.js';

let activeBucket = null;

register('storage', {
  title: 'Storage',
  async render(page) {
    if (!requireProject(page, 'Storage')) return;
    clear(page);
    const { buckets } = await get(`/api/admin/projects/${state.projectId}/buckets`);
    const usage = await get(`/api/admin/projects/${state.projectId}/storage/usage`);

    const bucketCards = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' } });
    if (!buckets.length) {
      bucketCards.append(emptyState({
        title: 'No buckets yet',
        sub: 'Buckets group files with their own access policy, size limits and MIME allow-lists.',
        icon: 'archive',
        action: h('button', { class: 'btn btn-primary', onclick: () => showBucketModal(null, render) }, icon('plus'), 'Create bucket'),
      }));
    } else {
      if (!activeBucket || !buckets.find((b) => b.id === activeBucket)) activeBucket = buckets[0].id;
      for (const b of buckets) {
        bucketCards.append(h('button', {
          class: `tile-card ${b.id === activeBucket ? '' : ''}`,
          style: {
            cursor: 'pointer', minWidth: '220px',
            borderColor: b.id === activeBucket ? 'var(--accent)' : 'var(--border)',
          },
          onclick: () => { activeBucket = b.id; render(page); },
        },
        h('div', { class: `tile-icon ${b.public ? 'green' : ''}` }, icon(b.public ? 'globe' : 'lock')),
        h('div', {},
          h('div', { class: 'tile-title' }, b.name),
          h('div', { class: 'tile-sub' }, `${fmtNumber(b.stats.files)} files · ${fmtBytes(b.stats.bytes)}`),
          h('div', { style: { marginTop: '5px', display: 'flex', gap: '5px' } },
            badge(b.public ? 'PUBLIC' : 'PRIVATE', b.public ? 'green' : 'gray'),
            badge(b.provider.toUpperCase(), 'outline')))));
      }
    }

    const objectsArea = h('div', {});
    const bucket = buckets.find((b) => b.id === activeBucket);
    if (bucket) renderObjects(objectsArea, bucket, () => render(page));

    page.append(
      h('div', { class: 'page-header' },
        h('div', {},
          h('h2', { class: 'page-title' }, 'Storage'),
          h('p', { class: 'page-subtitle' }, `Total usage: ${fmtBytes(usage.totalBytes)} across ${usage.buckets.length} buckets. Local filesystem by default; S3-compatible providers supported.`)),
        h('div', { class: 'page-actions' },
          h('button', { class: 'btn btn-ghost', onclick: () => showS3Modal() }, icon('server'), 'S3 provider'),
          h('button', { class: 'btn btn-secondary', onclick: () => showBucketModal(null, () => render(page)) }, icon('plus'), 'New bucket'),
          bucket ? h('button', { class: 'btn btn-primary', onclick: () => pickAndUpload(bucket, () => render(page)) }, icon('upload'), 'Upload files') : null)),
      bucketCards, objectsArea);
  },
});

async function renderObjects(area, bucket, refresh) {
  clear(area);
  const { objects } = await get(`/api/admin/projects/${state.projectId}/buckets/${bucket.id}/objects?limit=100`);
  const dropZone = h('div', {
    style: {
      border: '2px dashed var(--border-strong)', borderRadius: 'var(--radius-lg)',
      padding: '22px', textAlign: 'center', color: 'var(--text-faint)',
      cursor: 'pointer', marginBottom: '14px', transition: 'border-color .15s',
    },
    onclick: () => pickAndUpload(bucket, refresh),
  },
  icon('upload'), h('div', { style: { marginTop: '6px', fontSize: '13px' } }, 'Drop files here or click to upload'),
  h('div', { class: 'hint' }, `Max ${fmtBytes(bucket.max_file_size)} per file${bucket.allowedMimes?.length ? ` · allowed: ${bucket.allowedMimes.join(', ')}` : ''}`));

  const input = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
  input.addEventListener('change', async () => {
    for (const file of input.files) await uploadFile(bucket, file, refresh);
    input.value = '';
  });
  dropZone.append(input);
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = 'var(--accent)'; });
  dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = 'var(--border-strong)'; });
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'var(--border-strong)';
    for (const file of e.dataTransfer.files) await uploadFile(bucket, file, refresh);
  });

  area.append(dropZone);

  if (!objects.length) {
    area.append(emptyState({ title: 'Bucket is empty', sub: 'Upload files to get started.', icon: 'archive' }));
    return;
  }

  area.append(dataTable({
    columns: [
      { key: 'path', label: 'File', className: 'cell-mono' },
      { key: 'mime', label: 'Type', render: (o) => h('span', { class: 'cell-dim' }, o.mime) },
      { key: 'size', label: 'Size', render: (o) => fmtBytes(o.size) },
      { key: 'version', label: 'v', render: (o) => `v${o.version}` },
      { key: 'created_at', label: 'Uploaded', render: (o) => h('span', { class: 'cell-dim' }, fmtDate(o.created_at)) },
    ],
    rows: objects,
    rowActions: (o) => [
      h('button', { class: 'btn btn-ghost btn-sm', 'data-tip': 'Download', onclick: () => downloadObject(bucket, o) }, icon('download')),
      h('button', { class: 'btn btn-ghost btn-sm', 'data-tip': 'Signed URL', onclick: () => signObject(bucket, o) }, icon('key')),
      h('button', { class: 'btn btn-ghost btn-sm', 'data-tip': 'Delete', onclick: async () => {
        const ok = await confirmDialog({ title: `Delete ${o.path}?`, confirmText: 'Delete', danger: true });
        if (!ok) return;
        try { await del(`/api/admin/projects/${state.projectId}/buckets/${bucket.id}/objects/${o.path}`); toastSuccess('Object deleted'); refresh(); }
        catch (e) { toastError(e); }
      } }, icon('trash')),
    ],
  }));

  async function uploadFile(bucket_, file, refresh_) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch(`/api/admin/projects/${state.projectId}/buckets/${bucket_.id}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('bloop.adminToken')}` },
        body: fd,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
        throw new Error(err.error?.message || 'Upload failed');
      }
      toastSuccess(`${file.name} uploaded (${fmtBytes(file.size)})`);
      refresh_();
    } catch (e) { toastError(e); }
  }
}

async function pickAndUpload(bucket, refresh) {
  const input = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
  input.addEventListener('change', async () => {
    for (const file of input.files) {
      const fd = new FormData();
      fd.append('file', file);
      try {
        const res = await fetch(`/api/admin/projects/${state.projectId}/buckets/${bucket.id}/upload`, {
          method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('bloop.adminToken')}` }, body: fd,
        });
        if (!res.ok) throw new Error((await res.json())?.error?.message || 'Upload failed');
        toastSuccess(`${file.name} uploaded`);
      } catch (e) { toastError(e); }
    }
    refresh();
  });
  document.body.append(input);
  input.click();
  setTimeout(() => input.remove(), 5000);
}

async function downloadObject(bucket, o) {
  try {
    const res = await fetch(`/api/admin/projects/${state.projectId}/buckets/${bucket.id}/download/${o.path}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('bloop.adminToken')}` },
    });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const blob = await res.blob();
    const a = h('a', { href: URL.createObjectURL(blob), download: o.path });
    a.click();
  } catch (e) { toastError(e); }
}

function signObject(bucket, o) {
  modal({
    title: 'Signed URL',
    body: (async () => {
      const r = await post(`/api/admin/projects/${state.projectId}/buckets/${bucket.id}/sign`, { path: o.path, ttlSeconds: 900 });
      return h('div', {},
        h('div', { class: 'field' }, h('label', {}, 'Expires'), h('div', { class: 'cell-dim' }, `${r.ttlSeconds}s · ${fmtDate(r.expiresAt)}`)),
        h('div', { class: 'field' }, h('label', {}, 'URL'), copyChip(`${location.origin}${r.path}`, r.path.slice(0, 60) + '…')));
    })(),
  });
}

function showBucketModal(existing, refresh) {
  const name = h('input', { class: 'input mono', value: existing?.name || '', placeholder: 'avatars', disabled: !!existing });
  const publicCb = h('input', { type: 'checkbox' });
  publicCb.checked = !!existing?.public;
  const maxSize = h('input', { class: 'input mono', type: 'number', value: existing?.max_file_size || 52428800 });
  const mimes = h('input', { class: 'input mono', value: (existing?.allowedMimes || []).join(', '), placeholder: 'image/png, image/jpeg (empty = allow all)' });
  const provider = h('select', { class: 'input', disabled: !!existing },
    h('option', { value: 'local', selected: (existing?.provider || 'local') === 'local' }, 'local filesystem'),
    h('option', { value: 's3', selected: existing?.provider === 's3' }, 'S3-compatible'));
  const m = modal({
    title: existing ? `Edit bucket — ${existing.name}` : 'Create bucket',
    body: h('div', {},
      field('Name', name),
      checkboxRowEl(publicCb, 'Public bucket (objects served without auth via /storage/public/…)'),
      formRow(field('Max file size (bytes)', maxSize), field('Provider', provider)),
      field('Allowed MIME types', mimes, { hint: 'Comma-separated; content is also sniffed via magic bytes' })),
    footer: h('button', { class: 'btn btn-primary', onclick: async () => {
      try {
        const payload = {
          public: publicCb.checked, maxFileSize: Number(maxSize.value),
          allowedMimes: mimes.value.split(',').map((s) => s.trim()).filter(Boolean),
        };
        if (existing) await patch(`/api/admin/projects/${state.projectId}/buckets/${existing.id}`, payload);
        else await post(`/api/admin/projects/${state.projectId}/buckets`, { name: name.value, provider: provider.value, ...payload });
        toastSuccess(existing ? 'Bucket updated' : `Bucket “${name.value}” created`);
        m.close(); refresh();
      } catch (e) { toastError(e); }
    } }, existing ? 'Save' : 'Create bucket'),
  });
}

function checkboxRowEl(cb, label) {
  return h('label', { class: 'checkbox-row', style: { marginBottom: '14px' } }, cb, label);
}

function showS3Modal() {
  (async () => {
    const { config } = await get(`/api/admin/projects/${state.projectId}/storage/s3`);
    const endpoint = h('input', { class: 'input mono', value: config?.endpoint || '', placeholder: 'https://s3.amazonaws.com or http://minio:9000' });
    const region = h('input', { class: 'input mono', value: config?.region || 'us-east-1' });
    const bucketName = h('input', { class: 'input mono', value: config?.bucket || '' });
    const accessKey = h('input', { class: 'input mono', value: config?.accessKeyId || '' });
    const secretKey = h('input', { class: 'input mono', type: 'password', placeholder: config ? '•••••••• (unchanged)' : 'secret access key' });
    const m = modal({
      title: 'S3-compatible storage provider',
      size: 'modal-lg',
      body: h('div', {},
        field('Endpoint', endpoint),
        formRow(field('Region', region), field('Bucket', bucketName)),
        formRow(field('Access key ID', accessKey), field('Secret access key', secretKey, { hint: 'Stored encrypted; used for buckets with provider "s3" and off-site backups' })),
        h('div', { class: 'callout' }, 'Compatible with AWS S3, MinIO, Cloudflare R2 (path-style signing, SigV4).')),
      footer: h('button', { class: 'btn btn-primary', onclick: async () => {
        try {
          await put(`/api/admin/projects/${state.projectId}/storage/s3`, {
            endpoint: endpoint.value, region: region.value, bucket: bucketName.value,
            accessKeyId: accessKey.value, secretAccessKey: secretKey.value || undefined,
          });
          toastSuccess('S3 config saved (secret encrypted)'); m.close();
        } catch (e) { toastError(e); }
      } }, 'Save'),
    });
  })();
}
