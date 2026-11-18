// modules/nosql-engine.js — NoSQL Studio engine.
// Two honest modes:
//  1. "embedded" — a document store backed by the platform SQLite file
//     (collections registry + JSON documents + version history). MongoDB-style
//     query operators are evaluated in-process; aggregation runs in memory.
//  2. "mongodb" — full passthrough to a real MongoDB server via the optional
//     driver (real indexes, real aggregation, change streams).
// The mode and its limitations are surfaced through the API so the UI can
// label capabilities accurately.
import crypto from 'node:crypto';
import { badRequest, notFound, conflict } from '../core/error-handler.js';
import { validateOrThrow } from '../core/validation.js';

const MAX_DOC_BYTES = 512 * 1024; // per-document size cap on the embedded store

export class NosqlEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'nosql' });
  }

  get db() { return this.ctx.system; }

  async modeFor(projectId) {
    const conn = this.ctx.database.getDefaultConnection(projectId);
    if (conn && conn.provider === 'mongodb') return { mode: 'mongodb', connectionId: conn.id, provider: 'mongodb' };
    return { mode: 'embedded', connectionId: conn?.id || null, provider: 'sqlite-documents' };
  }

  // ── Collections ───────────────────────────────────────────────────────────
  async listCollections(projectId) {
    const mode = await this.modeFor(projectId);
    if (mode.mode === 'mongodb') {
      const adapter = await this.ctx.database.getAdapter(mode.connectionId);
      const cols = await adapter.listTables();
      const out = [];
      for (const c of cols) {
        out.push({ name: c.name, mode: 'mongodb', documents: await adapter.countDocuments(c.name).catch(() => null) });
      }
      return out;
    }
    const rows = this.db.all('SELECT * FROM collection_meta WHERE project_id = ? ORDER BY name', [projectId]);
    return rows.map((r) => ({
      id: r.id, name: r.name, mode: 'embedded',
      documents: this.db.get('SELECT COUNT(*) AS c FROM documents WHERE collection_id = ? AND deleted = 0', [r.id])?.c || 0,
      indexes: JSON.parse(r.indexes_json || '[]'),
      options: JSON.parse(r.options_json || '{}'),
      createdAt: r.created_at,
    }));
  }

  async createCollection(projectId, { name, options = {}, indexes = [] }) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw badRequest('Collection name must be alphanumeric (dashes/underscores), max 64 chars');
    const mode = await this.modeFor(projectId);
    if (mode.mode === 'mongodb') {
      const adapter = await this.ctx.database.getAdapter(mode.connectionId);
      await adapter.createCollection(name, options);
      for (const idx of indexes) await adapter.createIndex(name, idx).catch(() => { });
      return { name, mode: 'mongodb' };
    }
    const existing = this.db.get('SELECT id FROM collection_meta WHERE project_id = ? AND name = ?', [projectId, name]);
    if (existing) throw conflict(`Collection "${name}" already exists`);
    const id = crypto.randomUUID();
    this.db.run('INSERT INTO collection_meta (id, project_id, name, indexes_json, options_json, created_at) VALUES (?,?,?,?,?,?)',
      [id, projectId, name, JSON.stringify(indexes), JSON.stringify(options), new Date().toISOString()]);
    this.ctx.database.logActivity(projectId, mode.connectionId, 'nosql.collection.create', { name });
    return { id, name, mode: 'embedded' };
  }

  async dropCollection(projectId, name) {
    const mode = await this.modeFor(projectId);
    if (mode.mode === 'mongodb') {
      const adapter = await this.ctx.database.getAdapter(mode.connectionId);
      await adapter.dropTable(name);
      return { dropped: true };
    }
    const col = this.db.get('SELECT * FROM collection_meta WHERE project_id = ? AND name = ?', [projectId, name]);
    if (!col) throw notFound('Collection not found');
    this.db.run('DELETE FROM documents WHERE collection_id = ?', [col.id]);
    this.db.run('DELETE FROM collection_meta WHERE id = ?', [col.id]);
    return { dropped: true };
  }

  // ── Documents (embedded mode) ─────────────────────────────────────────────
  _collection(projectId, name) {
    const col = this.db.get('SELECT * FROM collection_meta WHERE project_id = ? AND name = ?', [projectId, name]);
    if (!col) throw notFound(`Collection "${name}" not found`);
    return col;
  }

  async insert(projectId, collectionName, docs, { principal = null } = {}) {
    const mode = await this.modeFor(projectId);
    if (mode.mode === 'mongodb') {
      const adapter = await this.ctx.database.getAdapter(mode.connectionId);
      const result = await adapter.insert(collectionName, docs);
      await this._emit(projectId, mode, collectionName, 'insert', null, Array.isArray(docs) ? docs[0] : docs);
      return { inserted: result.insertedCount, mode: 'mongodb' };
    }
    const col = this._collection(projectId, collectionName);
    const list = Array.isArray(docs) ? docs : [docs];
    let inserted = 0;
    const ids = [];
    for (const doc of list) {
      if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw badRequest('Each document must be a JSON object');
      const json = JSON.stringify(doc);
      if (Buffer.byteLength(json) > MAX_DOC_BYTES) throw badRequest(`Document exceeds the ${MAX_DOC_BYTES / 1024}KB embedded-store limit`);
      if (principal && !principal.bypassRls) {
        const okRows = this.ctx.policies.filterRows(projectId, collectionName, [doc], principal);
        if (!okRows.length && this.ctx.policies.policiesFor(projectId, collectionName).length) {
          throw badRequest('Document rejected by row-level security policy');
        }
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.db.run('INSERT INTO documents (id, project_id, collection_id, data_json, version, created_at, updated_at, deleted) VALUES (?,?,?,?,1,?,?,0)',
        [id, projectId, col.id, json, now, now]);
      ids.push(id);
      inserted++;
    }
    await this._emit(projectId, mode, collectionName, 'insert', null, list[0]);
    return { inserted, ids, mode: 'embedded' };
  }

  async find(projectId, collectionName, { filter = {}, sort = null, limit = 50, skip = 0, projection = null, countOnly = false, principal = null } = {}) {
    const mode = await this.modeFor(projectId);
    if (mode.mode === 'mongodb') {
      const adapter = await this.ctx.database.getAdapter(mode.connectionId);
      const mongoFilter = this._toMongoFilter(filter);
      if (countOnly) return { count: await adapter.countDocuments(collectionName, mongoFilter), documents: [] };
      let docs = await adapter.find(collectionName, mongoFilter, {
        sort: sort ? this._toMongoSort(sort) : null,
        limit: Math.min(limit, 500), skip,
        projection: projection ? this._toMongoProjection(projection) : null,
      });
      if (principal && !principal.bypassRls && this.ctx.policies.policiesFor(projectId, collectionName).length) {
        docs = this.ctx.policies.filterRows(projectId, collectionName, docs, principal);
      }
      return { documents: this._serializeMongoDocs(docs), mode: 'mongodb' };
    }
    const col = this._collection(projectId, collectionName);
    const rows = this.db.all('SELECT * FROM documents WHERE collection_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 20000', [col.id]);
    let docs = rows.map((r) => ({ _id: r.id, ...JSON.parse(r.data_json), _createdAt: r.created_at, _updatedAt: r.updated_at, _version: r.version }));
    docs = docs.filter((d) => matchFilter(d, filter));
    if (principal && !principal.bypassRls && this.ctx.policies.policiesFor(projectId, collectionName).length) {
      docs = this.ctx.policies.filterRows(projectId, collectionName, docs, principal);
    }
    const total = docs.length;
    if (sort) docs = applySort(docs, sort);
    const page = docs.slice(skip, skip + Math.min(limit, 500));
    if (projection) page.forEach((d) => projectFields(d, projection));
    return { documents: page, total, mode: 'embedded' };
  }

  async getDocument(projectId, collectionName, docId, principal = null) {
    const mode = await this.modeFor(projectId);
    if (mode.mode === 'mongodb') {
      const adapter = await this.ctx.database.getAdapter(mode.connectionId);
      const { ObjectId } = await import('mongodb').catch(() => ({ ObjectId: null }));
      const filter = ObjectId && /^[0-9a-f]{24}$/i.test(docId) ? { _id: new ObjectId(docId) } : { _id: docId };
      const doc = await adapter.findOne(collectionName, filter);
      if (!doc) throw notFound('Document not found');
      return this._serializeMongoDocs([doc])[0];
    }
    const col = this._collection(projectId, collectionName);
    const row = this.db.get('SELECT * FROM documents WHERE id = ? AND collection_id = ? AND deleted = 0', [docId, col.id]);
    if (!row) throw notFound('Document not found');
    return { _id: row.id, ...JSON.parse(row.data_json), _createdAt: row.created_at, _updatedAt: row.updated_at, _version: row.version };
  }

  async update(projectId, collectionName, filter, update, { many = false, principal = null } = {}) {
    const mode = await this.modeFor(projectId);
    if (mode.mode === 'mongodb') {
      const adapter = await this.ctx.database.getAdapter(mode.connectionId);
      const { ObjectId } = await import('mongodb').catch(() => ({ ObjectId: null }));
      let mongoFilter = this._toMongoFilter(filter);
      if (!many && mongoFilter._id && typeof mongoFilter._id === 'string' && ObjectId && /^[0-9a-f]{24}$/i.test(mongoFilter._id)) {
        mongoFilter = { ...mongoFilter, _id: new ObjectId(mongoFilter._id) };
      }
      const r = await adapter.update(collectionName, mongoFilter, this._toMongoUpdate(update), { many });
      await this._emit(projectId, mode, collectionName, 'update', null, null);
      return { matched: r.matchedCount, modified: r.modifiedCount, mode: 'mongodb' };
    }
    const col = this._collection(projectId, collectionName);
    const rows = this.db.all('SELECT * FROM documents WHERE collection_id = ? AND deleted = 0', [col.id]);
    let matched = 0, modified = 0;
    for (const row of rows) {
      const doc = { _id: row.id, ...JSON.parse(row.data_json) };
      if (!matchFilter(doc, filter)) continue;
      matched++;
      if (principal && !principal.bypassRls && this.ctx.policies.policiesFor(projectId, collectionName).length) {
        if (!this.ctx.policies.checkRow(projectId, collectionName, 'update', { before: doc, after: applyUpdate(doc, update) }, principal)) continue;
      }
      const before = JSON.parse(row.data_json);
      this.db.run('INSERT INTO document_history (document_id, project_id, version, data_json, changed_at) VALUES (?,?,?,?,?)',
        [row.id, projectId, row.version, JSON.stringify(before), new Date().toISOString()]);
      const updated = applyUpdate(doc, update);
      delete updated._id;
      this.db.run('UPDATE documents SET data_json = ?, version = version + 1, updated_at = ? WHERE id = ?',
        [JSON.stringify(updated), new Date().toISOString(), row.id]);
      modified++;
      if (!many) break;
    }
    if (modified) await this._emit(projectId, mode, collectionName, 'update', null, null);
    return { matched, modified, mode: 'embedded' };
  }

  async delete(projectId, collectionName, filter, { many = false, principal = null } = {}) {
    const mode = await this.modeFor(projectId);
    if (mode.mode === 'mongodb') {
      const adapter = await this.ctx.database.getAdapter(mode.connectionId);
      const r = await adapter.delete(collectionName, this._toMongoFilter(filter), { many });
      await this._emit(projectId, mode, collectionName, 'delete', null, null);
      return { deleted: r.deletedCount, mode: 'mongodb' };
    }
    const col = this._collection(projectId, collectionName);
    const rows = this.db.all('SELECT * FROM documents WHERE collection_id = ? AND deleted = 0', [col.id]);
    let deleted = 0;
    for (const row of rows) {
      const doc = { _id: row.id, ...JSON.parse(row.data_json) };
      if (!matchFilter(doc, filter)) continue;
      if (principal && !principal.bypassRls && this.ctx.policies.policiesFor(projectId, collectionName).length) {
        if (!this.ctx.policies.checkRow(projectId, collectionName, 'delete', doc, principal)) continue;
      }
      this.db.run('UPDATE documents SET deleted = 1, updated_at = ? WHERE id = ?', [new Date().toISOString(), row.id]);
      deleted++;
      if (!many) break;
    }
    if (deleted) await this._emit(projectId, mode, collectionName, 'delete', null, null);
    return { deleted, mode: 'embedded' };
  }

  async aggregate(projectId, collectionName, pipeline = [], principal = null) {
    const mode = await this.modeFor(projectId);
    if (mode.mode === 'mongodb') {
      const adapter = await this.ctx.database.getAdapter(mode.connectionId);
      const results = await adapter.aggregate(collectionName, pipeline);
      return { results: this._serializeMongoDocs(results), mode: 'mongodb' };
    }
    const col = this._collection(projectId, collectionName);
    const rows = this.db.all('SELECT * FROM documents WHERE collection_id = ? AND deleted = 0', [col.id]);
    let docs = rows.map((r) => ({ _id: r.id, ...JSON.parse(r.data_json) }));
    if (principal && !principal.bypassRls && this.ctx.policies.policiesFor(projectId, collectionName).length) {
      docs = this.ctx.policies.filterRows(projectId, collectionName, docs, principal);
    }
    return { results: runPipeline(docs, pipeline), mode: 'embedded (in-memory aggregation)' };
  }

  async createIndex(projectId, collectionName, spec) {
    const mode = await this.modeFor(projectId);
    if (mode.mode === 'mongodb') {
      const adapter = await this.ctx.database.getAdapter(mode.connectionId);
      const r = await adapter.createIndex(collectionName, spec);
      return { ...r, mode: 'mongodb (real index)' };
    }
    const col = this._collection(projectId, collectionName);
    const indexes = JSON.parse(col.indexes_json || '[]');
    const name = spec.name || `idx_${Object.keys(spec.keys || {}).join('_')}`.slice(0, 60);
    if (indexes.some((i) => i.name === name)) throw conflict('Index with that name already exists');
    indexes.push({ name, keys: spec.keys || {}, unique: !!spec.unique, createdAt: new Date().toISOString() });
    this.db.run('UPDATE collection_meta SET indexes_json = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(indexes), new Date().toISOString(), col.id]);
    return {
      name, mode: 'embedded',
      note: 'The embedded document store keeps indexes as metadata (query filtering is in-process). Install the mongodb driver and connect a MongoDB provider for physical indexes.',
    };
  }

  async listIndexes(projectId, collectionName) {
    const mode = await this.modeFor(projectId);
    if (mode.mode === 'mongodb') {
      const adapter = await this.ctx.database.getAdapter(mode.connectionId);
      return adapter.listIndexes(collectionName);
    }
    const col = this._collection(projectId, collectionName);
    return JSON.parse(col.indexes_json || '[]');
  }

  async dropIndex(projectId, collectionName, indexName) {
    const mode = await this.modeFor(projectId);
    if (mode.mode === 'mongodb') {
      const adapter = await this.ctx.database.getAdapter(mode.connectionId);
      return adapter.dropIndex(collectionName, indexName);
    }
    const col = this._collection(projectId, collectionName);
    const indexes = JSON.parse(col.indexes_json || '[]').filter((i) => i.name !== indexName);
    this.db.run('UPDATE collection_meta SET indexes_json = ? WHERE id = ?', [JSON.stringify(indexes), col.id]);
    return { dropped: true };
  }

  async documentHistory(projectId, collectionName, docId, { limit = 20 } = {}) {
    const mode = await this.modeFor(projectId);
    if (mode.mode === 'mongodb') {
      return { note: 'Document history is available on the embedded document store; MongoDB passthrough does not track history.', versions: [] };
    }
    const col = this._collection(projectId, collectionName);
    const rows = this.db.all('SELECT version, data_json, changed_at FROM document_history WHERE document_id = ? ORDER BY changed_at DESC LIMIT ?',
      [docId, limit]);
    return { versions: rows.map((r) => ({ version: r.version, data: JSON.parse(r.data_json), changedAt: r.changed_at })) };
  }

  async importJson(projectId, collectionName, documents, { upsert = false } = {}) {
    if (!Array.isArray(documents)) throw badRequest('import expects a JSON array of documents');
    const result = await this.insert(projectId, collectionName, documents);
    return { imported: result.inserted, mode: result.mode };
  }

  async exportJson(projectId, collectionName, { limit = 10000 } = {}) {
    const r = await this.find(projectId, collectionName, { limit, principal: { bypassRls: true } });
    return r.documents;
  }

  _serializeMongoDocs(docs) {
    return (docs || []).map((d) => {
      const out = {};
      for (const [k, v] of Object.entries(d || {})) {
        if (v && typeof v === 'object' && typeof v.toHexString === 'function') out[k] = v.toString();
        else if (v instanceof Date) out[k] = v.toISOString();
        else out[k] = v;
      }
      return out;
    });
  }

  async _emit(projectId, mode, collectionName, op, before, after) {
    try {
      this.ctx.realtime?.notifyDataChange(projectId, collectionName, op, after ? [after] : null);
    } catch { /* events are best-effort */ }
    try {
      await this.ctx.cdc?.recordChange({
        projectId,
        provider: mode.provider,
        connectionId: mode.connectionId,
        table: collectionName,
        op,
        before,
        after,
      });
    } catch { /* events are best-effort */ }
  }

  _toMongoFilter(filter) {
    // Embedded filters are already Mongo-shaped; pass through (string _id is
    // handled by callers where an ObjectId is required).
    return filter || {};
  }

  _toMongoSort(sort) {
    const out = {};
    for (const [k, v] of Object.entries(sort || {})) out[k] = v === 'desc' || v === -1 ? -1 : 1;
    return out;
  }

  _toMongoProjection(projection) {
    if (Array.isArray(projection)) return Object.fromEntries(projection.map((p) => [p, 1]));
    return projection || undefined;
  }

  _toMongoUpdate(update) {
    if (update.$set || update.$unset || update.$inc || update.$push) return update;
    return { $set: update };
  }
}

// ── Embedded-mode helpers ─────────────────────────────────────────────────────
export function matchFilter(doc, filter = {}) {
  if (!filter || typeof filter !== 'object') return true;
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$and') { if (!cond.every((f) => matchFilter(doc, f))) return false; continue; }
    if (key === '$or') { if (!cond.some((f) => matchFilter(doc, f))) return false; continue; }
    if (key === '$not') { if (matchFilter(doc, cond)) return false; continue; }
    const value = getPath(doc, key);
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      for (const [op, operand] of Object.entries(cond)) {
        if (!applyOperator(value, op, operand, doc)) return false;
      }
    } else {
      if (!looseEquals(value, cond)) return false;
    }
  }
  return true;
}

function applyOperator(value, op, operand, doc) {
  switch (op) {
    case '$eq': return looseEquals(value, operand);
    case '$ne': return !looseEquals(value, operand);
    case '$gt': return compare(value, operand) > 0;
    case '$gte': return compare(value, operand) >= 0;
    case '$lt': return compare(value, operand) < 0;
    case '$lte': return compare(value, operand) <= 0;
    case '$in': return Array.isArray(operand) && operand.some((o) => looseEquals(value, o));
    case '$nin': return Array.isArray(operand) && !operand.some((o) => looseEquals(value, o));
    case '$exists': return operand ? value !== undefined : value === undefined;
    case '$contains': return typeof value === 'string' && value.includes(String(operand));
    case '$regex': {
      if (typeof value !== 'string') return false;
      try { return new RegExp(operand).test(value); } catch { return false; }
    }
    case '$size': return Array.isArray(value) && value.length === operand;
    case '$elemMatch': return Array.isArray(value) && value.some((v) => matchFilter(v, operand));
    default: throw badRequest(`Unsupported filter operator "${op}"`);
  }
}

function looseEquals(a, b) {
  return a === b || String(a) === String(b) && a !== undefined && b !== undefined && !(a === null || b === null);
}

function compare(a, b) {
  if (a === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function getPath(doc, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
}

export function applySort(docs, sort) {
  const entries = Object.entries(sort || {});
  if (!entries.length) return docs;
  return [...docs].sort((a, b) => {
    for (const [k, dir] of entries) {
      const va = getPath(a, k), vb = getPath(b, k);
      if (va === vb) continue;
      const cmp = (va === undefined ? -1 : vb === undefined ? 1 : compare(va, vb));
      return dir === 'desc' || dir === -1 ? -cmp : cmp;
    }
    return 0;
  });
}

function projectFields(doc, projection) {
  if (Array.isArray(projection)) {
    for (const key of Object.keys(doc)) if (!projection.includes(key) && key !== '_id') delete doc[key];
    return doc;
  }
  const include = Object.entries(projection).filter(([, v]) => v);
  if (include.length) {
    for (const key of Object.keys(doc)) if (!include.some(([k]) => k === key) && key !== '_id') delete doc[key];
  } else {
    for (const [k, v] of Object.entries(projection)) if (!v) delete doc[k];
  }
  return doc;
}

export function applyUpdate(doc, update) {
  const out = JSON.parse(JSON.stringify(doc));
  if (update.$set) for (const [k, v] of Object.entries(update.$set)) setPath(out, k, v);
  if (update.$unset) for (const k of Object.keys(update.$unset)) unsetPath(out, k);
  if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) {
    const cur = getPath(out, k) || 0;
    if (typeof cur !== 'number') throw badRequest(`$inc target "${k}" is not numeric`);
    setPath(out, k, cur + v);
  }
  if (update.$push) for (const [k, v] of Object.entries(update.$push)) {
    const cur = getPath(out, k);
    if (!Array.isArray(cur)) throw badRequest(`$push target "${k}" is not an array`);
    cur.push(v);
  }
  if (update.$pull) for (const [k, cond] of Object.entries(update.$pull)) {
    const cur = getPath(out, k);
    if (Array.isArray(cur)) setPath(out, k, cur.filter((item) => !matchFilter(item, typeof cond === 'object' ? cond : { $eq: cond })));
  }
  if (!update.$set && !update.$unset && !update.$inc && !update.$push && !update.$pull) {
    // plain replacement document
    return { ...JSON.parse(JSON.stringify(update)) };
  }
  return out;
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function unsetPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return;
    cur = cur[parts[i]];
  }
  if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
}

// ── In-memory aggregation pipeline (embedded mode) ───────────────────────────
export function runPipeline(docs, pipeline) {
  let data = [...docs];
  for (const stage of pipeline) {
    const [name, spec] = Object.entries(stage)[0];
    switch (name) {
      case '$match': data = data.filter((d) => matchFilter(d, spec)); break;
      case '$sort': data = applySort(data, spec); break;
      case '$limit': data = data.slice(0, spec); break;
      case '$skip': data = data.slice(spec); break;
      case '$project':
        data = data.map((d) => {
          const copy = JSON.parse(JSON.stringify(d));
          return projectFields(copy, spec);
        });
        break;
      case '$group': data = runGroup(data, spec); break;
      case '$count': data = [{ count: data.length }]; break;
      case '$unwind': {
        const field = String(spec).replace(/^\$/, '');
        const out = [];
        for (const d of data) {
          const arr = getPath(d, field);
          if (Array.isArray(arr)) for (const item of arr) out.push({ ...d, [field]: item });
        }
        data = out;
        break;
      }
      default: throw badRequest(`Unsupported aggregation stage "${name}" (embedded mode supports $match, $group, $sort, $limit, $skip, $project, $count, $unwind)`);
    }
  }
  return data;
}

function runGroup(data, spec) {
  const groups = new Map();
  const accs = Object.entries(spec).filter(([k]) => k !== '_id');
  const idKey = spec._id !== undefined ? spec._id : null;
  for (const d of data) {
    const key = idKey === null ? null
      : typeof idKey === 'string' && idKey.startsWith('$') ? getPath(d, idKey.slice(1))
        : typeof idKey === 'object' && idKey ? JSON.stringify(mapRef(idKey, d)) : idKey;
    if (!groups.has(key)) groups.set(key, { _id: key });
    const g = groups.get(key);
    for (const [field, expr] of accs) {
      const op = Object.keys(expr)[0];
      const operand = expr[op];
      const value = typeof operand === 'string' && operand.startsWith('$') ? getPath(d, operand.slice(1)) : operand;
      if (!g[field]) g[field] = { op, values: [] };
      g[field].values.push(value);
    }
  }
  const out = [];
  for (const g of groups.values()) {
    const res = { _id: g._id };
    for (const [field, acc] of Object.entries(g)) {
      if (field === '_id') continue;
      const vals = acc.values.filter((v) => v !== undefined && v !== null);
      switch (acc.op) {
        case '$sum': res[field] = vals.reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0); break;
        case '$avg': res[field] = vals.length ? vals.reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0) / vals.length : null; break;
        case '$min': res[field] = vals.length ? Math.min(...vals.filter((v) => typeof v === 'number')) : null; break;
        case '$max': res[field] = vals.length ? Math.max(...vals.filter((v) => typeof v === 'number')) : null; break;
        case '$count': res[field] = vals.length; break;
        case '$push': res[field] = acc.values; break;
        case '$addToSet': res[field] = [...new Set(acc.values.map((v) => JSON.stringify(v)))].map((s) => JSON.parse(s)); break;
        default: throw badRequest(`Unsupported group accumulator "${acc.op}"`);
      }
    }
    out.push(res);
  }
  return out;
}

function mapRef(obj, doc) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'string' && v.startsWith('$') ? getPath(doc, v.slice(1)) : v;
  }
  return out;
}

export async function register(ctx) {
  ctx.nosql = new NosqlEngine(ctx);
}
