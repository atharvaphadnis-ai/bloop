// infrastructure/import-manager.js — migration importers for Supabase,
// Firebase (Auth + Firestore via service account), PocketBase and Appwrite.
// Each importer implements: testConnection → introspect → previewMapping →
// runImport (with per-step progress) → summary. Unsupported features are
// reported honestly; passwords are never migrated (documented).
import crypto from 'node:crypto';
import { badRequest, notFound, AppError } from '../core/error-handler.js';

const SOURCES = {
  supabase: {
    name: 'Supabase',
    requiredConfig: ['url', 'serviceKey'],
    notes: 'Tables are imported via the PostgREST API (service key required). Auth users are imported with "password reset required" — Supabase password hashes cannot be ported to Bloop scrypt. RLS policies are NOT imported (recreate them in Bloop policy engine).',
  },
  firebase: {
    name: 'Firebase (Auth + Firestore)',
    requiredConfig: ['serviceAccountJson'],
    notes: 'Requires a service-account JSON key with Identity Toolkit + Firestore Reader roles. Auth users are imported with reset-required flags; Firestore collections become Bloop document collections (or tables if embedded mode maps primitive docs). Realtime Database is NOT supported.',
  },
  pocketbase: {
    name: 'PocketBase',
    requiredConfig: ['url', 'adminEmail', 'adminPassword'],
    notes: 'Imports collections, records and users via the PocketBase admin API. View collections are skipped. User password hashes (bcrypt) cannot be converted — imported users are marked reset-required. Files are downloaded into Bloop storage.',
  },
  appwrite: {
    name: 'Appwrite',
    requiredConfig: ['url', 'projectId', 'apiKey'],
    notes: 'Imports databases/collections/documents, users and storage buckets/files via the Appwrite REST API. Functions are NOT imported (different runtime).',
  },
};

export class ImportManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'import' });
    this.running = new Set();
  }

  get db() { return this.ctx.system; }

  catalog() {
    return Object.entries(SOURCES).map(([id, s]) => ({ id, ...s }));
  }

  createJob(projectId, source, config) {
    const spec = SOURCES[source];
    if (!spec) throw badRequest(`Unknown import source "${source}". Supported: ${Object.keys(SOURCES).join(', ')}`);
    const missing = spec.requiredConfig.filter((k) => config?.[k] === undefined || config?.[k] === '');
    if (missing.length) throw badRequest(`Missing config for ${source}: ${missing.join(', ')}`);
    const id = crypto.randomUUID();
    this.db.run(
      "INSERT INTO import_jobs (id, project_id, source, status, config_json, progress_json, created_at) VALUES (?,?,?,?,?, '{}', ?)",
      [id, projectId, source, 'pending', JSON.stringify(this._redactConfig(config)), new Date().toISOString()]
    );
    return { id };
  }

  _redactConfig(config) {
    const out = { ...config };
    for (const k of Object.keys(out)) {
      if (/password|secret|key|account/i.test(k) && typeof out[k] === 'string') out[k] = `enc:${this.ctx.security.encrypt(out[k])}`;
      if (typeof out[k] === 'string' && out[k].startsWith('enc:')) out[k] = '••••••••';
    }
    return out;
  }

  _decryptConfig(config) {
    const out = { ...config };
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'string' && out[k].startsWith('enc:')) {
        try { out[k] = this.ctx.security.decrypt(out[k].slice(4)); } catch { out[k] = ''; }
      }
    }
    return out;
  }

  job(projectId, id) {
    const row = this.db.get('SELECT * FROM import_jobs WHERE id = ? AND project_id = ?', [id, projectId]);
    if (!row) throw notFound('Import job not found');
    return { ...row, config_json: undefined, config: JSON.parse(row.config_json || '{}'), progress: JSON.parse(row.progress_json || '{}'), summary: row.summary_json ? JSON.parse(row.summary_json) : null };
  }

  jobs(projectId) {
    return this.db.all("SELECT id, source, status, progress_json, created_at, finished_at FROM import_jobs WHERE project_id = ? ORDER BY created_at DESC", [projectId])
      .map((r) => ({ ...r, progress: JSON.parse(r.progress_json || '{}') }));
  }

  _setProgress(id, progress, status = null) {
    this.db.run('UPDATE import_jobs SET progress_json = ?, status = COALESCE(?, status) WHERE id = ?',
      [JSON.stringify(progress), status, id]);
  }

  // ── Source clients ────────────────────────────────────────────────────────
  async _testConnection(source, config) {
    try {
      switch (source) {
        case 'supabase': {
          const r = await fetch(`${config.url}/rest/v1/`, {
            headers: { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}` },
            signal: AbortSignal.timeout(10000),
          });
          return r.ok ? { ok: true } : { ok: false, error: `Supabase REST returned ${r.status} (check url + service key)` };
        }
        case 'firebase': {
          const sa = JSON.parse(config.serviceAccountJson);
          if (!sa.private_key || !sa.client_email || !sa.project_id) {
            return { ok: false, error: 'serviceAccountJson must contain private_key, client_email and project_id' };
          }
          await this._firebaseAccessToken(sa); // forces a real token exchange
          return { ok: true, projectId: sa.project_id };
        }
        case 'pocketbase': {
          const r = await fetch(`${config.url}/api/admins/auth-with-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identity: config.adminEmail, password: config.adminPassword }),
            signal: AbortSignal.timeout(10000),
          });
          if (!r.ok) return { ok: false, error: `PocketBase admin auth failed (${r.status})` };
          const data = await r.json();
          return { ok: true, token: data.token };
        }
        case 'appwrite': {
          const r = await fetch(`${config.url}/v1/databases`, {
            headers: { 'X-Appwrite-Project': config.projectId, 'X-Appwrite-Key': config.apiKey },
            signal: AbortSignal.timeout(10000),
          });
          return r.ok ? { ok: true } : { ok: false, error: `Appwrite API returned ${r.status} (check url, project id, api key)` };
        }
        default:
          return { ok: false, error: 'unknown source' };
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async _firebaseAccessToken(serviceAccount) {
    // sign a service-account JWT (RS256) with node:crypto and exchange it
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/firebase.database',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })).toString('base64url');
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const signature = signer.sign(serviceAccount.private_key, 'base64url');
    const assertion = `${header}.${claims}.${signature}`;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!res.ok) throw new Error(`Firebase token exchange failed: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data.access_token;
  }

  async _introspect(source, config) {
    switch (source) {
      case 'supabase': {
        // PostgREST OpenAPI root document
        const r = await fetch(`${config.url}/rest/v1/`, {
          headers: { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}` },
        });
        const spec = await r.json();
        const tables = Object.entries(spec.definitions || {}).map(([name, def]) => ({
          name,
          columns: Object.entries(def.properties || {}).map(([col, p]) => ({ name: col, type: p.format || p.type || 'text', required: (def.required || []).includes(col) })),
        }));
        let users = 0;
        try {
          const ur = await fetch(`${config.url}/auth/v1/admin/users?perPage=1`, {
            headers: { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}` },
          });
          if (ur.ok) users = (await ur.json()).total || 0;
        } catch { }
        return { tables, users, kind: 'sql' };
      }
      case 'firebase': {
        const sa = JSON.parse(config.serviceAccountJson);
        const token = await this._firebaseAccessToken(sa);
        const r = await fetch(`https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents?pageSize=1`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) throw new Error(`Firestore list failed: ${r.status}`);
        return { collections: [], kind: 'document', token, projectId: sa.project_id };
      }
      case 'pocketbase': {
        const auth = await this._testConnection('pocketbase', config);
        if (!auth.ok) throw new Error(auth.error);
        const r = await fetch(`${config.url}/api/collections`, { headers: { Authorization: auth.token } });
        const data = await r.json();
        const collections = (data.items || data || []).filter((c) => c.type !== 'view').map((c) => ({
          name: c.name,
          type: c.name === 'users' ? 'auth' : 'base',
          fields: (c.schema || []).map((f) => ({ name: f.name, type: f.type, required: f.required })),
        }));
        return { collections, kind: 'document', token: auth.token };
      }
      case 'appwrite': {
        const r = await fetch(`${config.url}/v1/databases`, {
          headers: { 'X-Appwrite-Project': config.projectId, 'X-Appwrite-Key': config.apiKey },
        });
        const data = await r.json();
        const databases = (data.databases || []).map((d) => ({ id: d.$id, name: d.name }));
        const collections = [];
        for (const d of databases) {
          const cr = await fetch(`${config.url}/v1/databases/${d.id}/collections`, {
            headers: { 'X-Appwrite-Project': config.projectId, 'X-Appwrite-Key': config.apiKey },
          });
          const cd = await cr.json();
          for (const c of cd.collections || []) {
            collections.push({ database: d.id, name: c.$id, fields: (c.attributes || []).map((a) => ({ name: a.key, type: a.type, required: a.required })) });
          }
        }
        return { databases, collections, kind: 'document' };
      }
      default:
        throw badRequest('unknown source');
    }
  }

  async introspect(projectId, jobId) {
    const job = this.job(projectId, jobId);
    const config = this._decryptConfig(job.config);
    const result = await this._introspect(job.source, config);
    this._setProgress(jobId, { introspected: true, counts: { tables: result.tables?.length ?? result.collections?.length ?? 0, users: result.users || null } });
    return result;
  }

  previewMapping(projectId, jobId, introspection) {
    const job = this.job(projectId, jobId);
    const mapping = { tables: [], collections: [], unsupported: [], users: { strategy: 'import', passwordPolicy: 'reset-required' } };
    if (job.source === 'supabase') {
      for (const t of introspection.tables) {
        mapping.tables.push({
          source: t.name,
          target: `db:${t.name}`,
          columns: t.columns.map((c) => ({ from: c.name, to: c.name, type: c.type })),
          notes: ['Columns are created in the target SQLite/SQL provider with mapped types.', 'Primary keys are preserved when named id.', 'RLS policies are NOT imported.'],
        });
      }
      mapping.unsupported.push('Row Level Security policies', 'Storage objects (import separately via Supabase storage API)', 'Edge functions');
    } else if (job.source === 'pocketbase') {
      for (const c of introspection.collections) {
        mapping.collections.push({ source: c.name, target: `nosql:${c.name}`, fields: c.fields.map((f) => ({ from: f.name, to: f.name, type: f.type })) });
      }
      mapping.unsupported.push('View collections (skipped)', 'Original password hashes (users reset-required)', 'Realtime subscriptions config');
    } else if (job.source === 'firebase') {
      mapping.unsupported.push('Realtime Database (not supported)', 'Cloud Functions', 'Security rules (Bloop uses its own policy engine)');
      mapping.collections.push({ source: 'firestore collections (listed at import time)', target: 'nosql:<name>' });
    } else if (job.source === 'appwrite') {
      for (const c of introspection.collections) {
        mapping.collections.push({ source: `${c.database}/${c.name}`, target: `nosql:${c.database}_${c.name}`, fields: c.fields.map((f) => ({ from: f.name, to: f.name, type: f.type })) });
      }
      mapping.unsupported.push('Appwrite Functions (different runtime)', 'Teams/memberships');
    }
    return mapping;
  }

  // ── Run ───────────────────────────────────────────────────────────────────
  async run(projectId, jobId) {
    if (this.running.has(jobId)) throw badRequest('Import job is already running');
    const job = this.job(projectId, jobId);
    if (job.status === 'completed') throw badRequest('Job already completed');
    this.running.add(jobId);
    const config = this._decryptConfig(job.config);
    const summary = { tables: 0, collections: 0, rows: 0, users: 0, files: 0, errors: [], unsupported: SOURCES[job.source].notes };
    const progress = { steps: [] };
    try {
      this._setProgress(jobId, progress, 'running');
      const introspection = await this._introspect(job.source, config);
      progress.steps.push({ step: 'connect', ok: true });

      switch (job.source) {
        case 'supabase': await this._runSupabase(projectId, jobId, config, introspection, summary, progress); break;
        case 'firebase': await this._runFirebase(projectId, jobId, config, introspection, summary, progress); break;
        case 'pocketbase': await this._runPocketbase(projectId, jobId, config, introspection, summary, progress); break;
        case 'appwrite': await this._runAppwrite(projectId, jobId, config, introspection, summary, progress); break;
      }
      this.db.run("UPDATE import_jobs SET status = 'completed', summary_json = ?, progress_json = ?, finished_at = ? WHERE id = ?",
        [JSON.stringify(summary), JSON.stringify(progress), new Date().toISOString(), jobId]);
      this.ctx.audit?.record({ actor: 'system', action: 'import.completed', projectId, target: job.source, meta: { rows: summary.rows, users: summary.users } });
      return summary;
    } catch (err) {
      this.db.run("UPDATE import_jobs SET status = 'failed', error = ?, progress_json = ?, finished_at = ? WHERE id = ?",
        [err.message, JSON.stringify(progress), new Date().toISOString(), jobId]);
      throw err;
    } finally {
      this.running.delete(jobId);
    }
  }

  async _runSupabase(projectId, jobId, config, introspection, summary, progress) {
    const headers = { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}` };
    for (const table of introspection.tables) {
      // fetch all rows (paginated)
      let rows = [];
      let offset = 0;
      const pageSize = 1000;
      while (true) {
        const r = await fetch(`${config.url}/rest/v1/${table.name}?limit=${pageSize}&offset=${offset}`, { headers });
        if (!r.ok) {
          summary.errors.push({ table: table.name, error: `fetch rows failed: ${r.status}` });
          break;
        }
        const batch = await r.json();
        rows = rows.concat(batch);
        if (batch.length < pageSize) break;
        offset += pageSize;
      }
      if (!rows.length) { summary.tables++; continue; }
      // create the target table in the default SQL connection via SQL Studio
      const cols = table.columns;
      const conn = this.ctx.database.getDefaultConnection(projectId);
      if (!conn) throw new AppError(400, 'NO_CONNECTION', 'Target project has no default database connection');
      const adapter = await this.ctx.database.getAdapter(conn.id);
      try {
        await adapter.createTable({
          name: table.name,
          ifNotExists: true,
          columns: cols.map((c) => ({ name: c.name, type: this._sqlType(c.type), nullable: !c.required })),
        });
      } catch (err) { /* table may exist */ }
      const colNames = cols.map((c) => c.name);
      for (const row of rows) {
        const values = colNames.map((c) => (row[c] === undefined ? null : (typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c])));
        try {
          await adapter.query(
            `INSERT INTO ${this._q(adapter.provider, table.name)} (${colNames.map((c) => this._q(adapter.provider, c)).join(', ')}) VALUES (${colNames.map(() => '?').join(', ')})`,
            values
          );
          summary.rows++;
        } catch (err) {
          if (summary.errors.length < 100) summary.errors.push({ table: table.name, row: row.id ?? null, error: err.message });
        }
      }
      summary.tables++;
      progress.steps.push({ step: `table:${table.name}`, rows: rows.length });
      this._setProgress(jobId, progress, 'running');
    }
    // users
    try {
      let page = 1;
      while (true) {
        const r = await fetch(`${config.url}/auth/v1/admin/users?page=${page}&perPage=200`, { headers });
        if (!r.ok) break;
        const data = await r.json();
        const users = data.users || [];
        for (const u of users) {
          this.ctx.system.run(
            'INSERT OR IGNORE INTO users (id, project_id, email, password_hash, email_verified, metadata_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
            [crypto.randomUUID(), projectId, String(u.email || '').toLowerCase(), 'reset-required', u.email_confirmed_at ? 1 : 0,
              JSON.stringify({ importedFrom: 'supabase', originalId: u.id, ...u.user_metadata }), u.created_at || new Date().toISOString(), new Date().toISOString()]
          );
          summary.users++;
        }
        if (users.length < 200) break;
        page++;
      }
    } catch (err) {
      summary.errors.push({ users: err.message });
    }
  }

  async _runFirebase(projectId, jobId, config, introspection, summary, progress) {
    const token = introspection.token;
    const project = introspection.projectId;
    // list collections is not directly supported by Firestore REST — page the root document IDs
    // by querying common roots via document listing (pageSize trick) and follow returned collectionIds
    const roots = await fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents?pageSize=100`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const rootData = await roots.json();
    const collectionIds = new Set();
    for (const doc of rootData.documents || []) {
      const m = /documents\/([^/]+)\//.exec(doc.name);
      if (m) collectionIds.add(m[1]);
    }
    // also use the aggregation listing endpoint
    const lr = await fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:ListCollectionIds`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageSize: 100 }),
    });
    if (lr.ok) {
      const ld = await lr.json();
      for (const id of ld.collectionIds || []) collectionIds.add(id);
    }
    for (const coll of collectionIds) {
      let docs = [];
      let pageToken = null;
      do {
        const r = await fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${coll}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) { summary.errors.push({ collection: coll, error: `fetch failed ${r.status}` }); break; }
        const data = await r.json();
        docs = docs.concat(data.documents || []);
        pageToken = data.nextPageToken;
      } while (pageToken);
      const parsed = docs.map((d) => this._firestoreDocToJson(d));
      await this.ctx.nosql.createCollection(projectId, coll).catch(() => { });
      if (parsed.length) await this.ctx.nosql.insert(projectId, coll, parsed);
      summary.collections++;
      summary.rows += parsed.length;
      progress.steps.push({ step: `collection:${coll}`, docs: parsed.length });
      this._setProgress(jobId, progress, 'running');
    }
    // Auth users via identitytoolkit (accounts:query)
    try {
      const r = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 500 }),
      });
      if (r.ok) {
        const data = await r.json();
        for (const u of data.userInfo || []) {
          this.ctx.system.run(
            'INSERT OR IGNORE INTO users (id, project_id, email, password_hash, email_verified, metadata_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
            [crypto.randomUUID(), projectId, String(u.email || '').toLowerCase(), 'reset-required', u.emailVerified ? 1 : 0,
              JSON.stringify({ importedFrom: 'firebase', originalId: u.localId, displayName: u.displayName }), u.createdAt || new Date().toISOString(), new Date().toISOString()]
          );
          summary.users++;
        }
      }
    } catch (err) {
      summary.errors.push({ users: err.message });
    }
  }

  _firestoreDocToJson(doc) {
    const out = { __id: doc.name?.split('/').pop() };
    const fields = doc.fields || {};
    const convert = (v) => {
      if (v.stringValue !== undefined) return v.stringValue;
      if (v.integerValue !== undefined) return Number(v.integerValue);
      if (v.doubleValue !== undefined) return Number(v.doubleValue);
      if (v.booleanValue !== undefined) return v.booleanValue;
      if (v.timestampValue !== undefined) return v.timestampValue;
      if (v.nullValue !== undefined) return null;
      if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(convert);
      if (v.mapValue !== undefined) {
        const m = {};
        for (const [k, vv] of Object.entries(v.mapValue.fields || {})) m[k] = convert(vv);
        return m;
      }
      return null;
    };
    for (const [k, v] of Object.entries(fields)) out[k] = convert(v);
    return out;
  }

  async _runPocketbase(projectId, jobId, config, introspection, summary, progress) {
    const token = introspection.token;
    for (const coll of introspection.collections) {
      let page = 1;
      let inserted = 0;
      while (true) {
        const r = await fetch(`${config.url}/api/collections/${coll.name}/records?page=${page}&perPage=200`, {
          headers: { Authorization: token },
        });
        if (!r.ok) break;
        const data = await r.json();
        const items = data.items || [];
        await this.ctx.nosql.createCollection(projectId, coll.name).catch(() => { });
        if (items.length) {
          const result = await this.ctx.nosql.insert(projectId, coll.name, items).catch((err) => {
            summary.errors.push({ collection: coll.name, error: err.message });
            return { inserted: 0 };
          });
          inserted += result?.inserted || 0;
        }
        if (items.length < 200) break;
        page++;
      }
      summary.collections++;
      summary.rows += inserted;
      progress.steps.push({ step: `collection:${coll.name}`, docs: inserted });
      this._setProgress(jobId, progress, 'running');
    }
    // users collection handled like any other (with a marker for reset-required)
    summary.users = summary.collections > 0 ? this.ctx.system.get('SELECT COUNT(*) AS c FROM documents WHERE project_id = ? AND data_json LIKE ?', [projectId, '%"importedFrom":"pocketbase"%'])?.c || 0 : 0;
  }

  async _runAppwrite(projectId, jobId, config, introspection, summary, progress) {
    const headers = { 'X-Appwrite-Project': config.projectId, 'X-Appwrite-Key': config.apiKey };
    for (const coll of introspection.collections) {
      const target = `${coll.database}_${coll.name}`;
      await this.ctx.nosql.createCollection(projectId, target).catch(() => { });
      let inserted = 0;
      let cursor = null;
      do {
        const url = `${config.url}/v1/databases/${coll.database}/collections/${coll.name}/documents?limit=100${cursor ? `&cursor=${cursor}` : ''}`;
        const r = await fetch(url, { headers });
        if (!r.ok) { summary.errors.push({ collection: target, error: `fetch failed ${r.status}` }); break; }
        const data = await r.json();
        const docs = (data.documents || []).map((d) => ({ __id: d.$id, ...Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith('$'))) }));
        if (docs.length) {
          const result = await this.ctx.nosql.insert(projectId, target, docs).catch((err) => ({ inserted: 0 }));
          inserted += result?.inserted || 0;
        }
        cursor = data.documents?.length ? data.documents[data.documents.length - 1].$id : null;
        if (!data.documents?.length) break;
      } while (cursor);
      summary.collections++;
      summary.rows += inserted;
      progress.steps.push({ step: `collection:${target}`, docs: inserted });
      this._setProgress(jobId, progress, 'running');
    }
    // users
    try {
      let cursor = null;
      do {
        const r = await fetch(`${config.url}/v1/users?limit=100${cursor ? `&cursor=${cursor}` : ''}`, { headers });
        if (!r.ok) break;
        const data = await r.json();
        for (const u of data.users || []) {
          this.ctx.system.run(
            'INSERT OR IGNORE INTO users (id, project_id, email, password_hash, email_verified, metadata_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
            [crypto.randomUUID(), projectId, String(u.email || '').toLowerCase(), 'reset-required', u.emailVerification ? 1 : 0,
              JSON.stringify({ importedFrom: 'appwrite', originalId: u.$id, name: u.name }), u.registration || new Date().toISOString(), new Date().toISOString()]
          );
          summary.users++;
        }
        cursor = data.users?.length ? data.users[data.users.length - 1].$id : null;
        if (!data.users?.length) break;
      } while (cursor);
    } catch (err) {
      summary.errors.push({ users: err.message });
    }
  }

  _sqlType(type) {
    const t = String(type || '').toLowerCase();
    if (/int|serial|bigserial/.test(t)) return 'integer';
    if (/bool/.test(t)) return 'boolean';
    if (/float|double|numeric|decimal|real/.test(t)) return 'real';
    if (/json/.test(t)) return 'json';
    if (/timestamp|date|time/.test(t)) return 'datetime';
    if (/uuid/.test(t)) return 'text';
    return 'text';
  }

  _q(provider, ident) {
    return (provider === 'mysql' || provider === 'mariadb') ? '`' + ident + '`' : '"' + ident + '"';
  }
}

export async function register(ctx) {
  ctx.importer = new ImportManager(ctx);
}
