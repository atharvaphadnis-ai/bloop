// modules/mongodb-adapter.js — MongoDB adapter via the optional "mongodb"
// driver. Collections, documents, aggregation pipelines, indexes and change
// streams (replica-set required for streams — reported honestly).
import { BaseAdapter, registerAdapter, detectDriver } from './database-adapters.js';
import { AppError } from '../core/error-handler.js';

export class MongoDbAdapter extends BaseAdapter {
  constructor(connectionId, config) {
    super('mongodb', connectionId, config);
    this.client = null;
    this.dbh = null;
  }

  static async driver() {
    const mod = await detectDriver('mongodb');
    if (!mod) {
      throw new AppError(501, 'DRIVER_MISSING',
        'MongoDB support requires the optional "mongodb" driver. Install it with: npm install mongodb');
    }
    return mod;
  }

  async connect() {
    if (this.client) return this;
    const { MongoClient } = await MongoDbAdapter.driver();
    this.client = new MongoClient(this.config.url, {
      serverSelectionTimeoutMS: 10_000,
      maxPoolSize: this.config.poolMax || 10,
    });
    await this.client.connect();
    this.dbh = this.client.db(this.config.database || undefined);
    this.connected = true;
    return this;
  }

  async disconnect() {
    if (this.client) { try { await this.client.close(); } catch { } this.client = null; this.dbh = null; }
    this.connected = false;
  }

  async health() {
    try {
      await this.connect();
      await this.dbh.command({ ping: 1 });
      return { status: 'ok', provider: 'mongodb', database: this.dbh.databaseName };
    } catch (err) {
      this.connected = false;
      return { status: 'down', provider: 'mongodb', error: err.message };
    }
  }

  _noSql() {
    throw new AppError(400, 'CAPABILITY_UNSUPPORTED', 'MongoDB does not support SQL queries. Use the NoSQL Explorer.');
  }

  async query() { this._noSql(); }
  async exec() { this._noSql(); }

  collection(name) {
    return this.dbh.collection(name);
  }

  async listTables() {
    await this.connect();
    const names = await this.dbh.listCollections().toArray();
    return names.map((c) => ({ name: c.name, type: 'collection' }));
  }

  async listColumns(collection) {
    // MongoDB has no fixed schema; sample documents to infer fields.
    await this.connect();
    const docs = await this.collection(collection).find({}).limit(50).toArray();
    const fields = new Map();
    for (const d of docs) {
      for (const [k, v] of Object.entries(d)) {
        const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v;
        if (!fields.has(k)) fields.set(k, { name: k, type: t, sample: t === 'object' || t === 'array' ? '[object]' : v });
      }
    }
    return [...fields.values()];
  }

  async listIndexes(collection) {
    await this.connect();
    const idx = await this.collection(collection).indexes().toArray();
    return idx.map((i) => ({ name: i.name, unique: !!i.unique, columns: Object.keys(i.key), sparse: !!i.sparse }));
  }

  async createIndex(collection, { keys = {}, name, unique = false, sparse = false, ttlSeconds }) {
    await this.connect();
    const options = { name, unique, sparse };
    if (ttlSeconds) options.expireAfterSeconds = ttlSeconds;
    const res = await this.collection(collection).createIndex(keys, options);
    return { ok: true, indexName: res };
  }

  async dropIndex(collection, name) {
    await this.connect();
    await this.collection(collection).dropIndex(name);
    return { ok: true };
  }

  async createCollection(name, { capped, size, max } = {}) {
    await this.connect();
    const exists = (await this.dbh.listCollections({ name }).toArray()).length > 0;
    if (exists) throw new AppError(409, 'CONFLICT', `Collection "${name}" already exists`);
    const opts = {};
    if (capped) { opts.capped = true; opts.size = size || 10485760; opts.max = max; }
    await this.dbh.createCollection(name, opts);
    return { ok: true };
  }

  async dropTable(name) {
    await this.connect();
    await this.collection(name).drop().catch((err) => {
      if (err.codeName !== 'NamespaceNotFound') throw err;
    });
    return { ok: true };
  }

  async find(collection, filter = {}, { sort = null, limit = 100, skip = 0, projection = null } = {}) {
    await this.connect();
    let cursor = this.collection(collection).find(filter, { limit: Math.min(limit, 1000), skip, projection: projection || undefined });
    if (sort) cursor = cursor.sort(sort);
    const docs = await cursor.toArray();
    return docs;
  }

  async findOne(collection, filter = {}) {
    await this.connect();
    return this.collection(collection).findOne(filter);
  }

  async countDocuments(collection, filter = {}) {
    await this.connect();
    return this.collection(collection).countDocuments(filter);
  }

  async insert(collection, docs) {
    await this.connect();
    if (Array.isArray(docs)) {
      const r = await this.collection(collection).insertMany(docs);
      return { insertedCount: r.insertedCount, ids: r.insertedIds };
    }
    const r = await this.collection(collection).insertOne(docs);
    return { insertedCount: 1, id: r.insertedId };
  }

  async update(collection, filter, update, { many = false } = {}) {
    await this.connect();
    const col = this.collection(collection);
    const r = many ? await col.updateMany(filter, update) : await col.updateOne(filter, update);
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  async delete(collection, filter, { many = false } = {}) {
    await this.connect();
    const r = many ? await this.collection(collection).deleteMany(filter) : await this.collection(collection).deleteOne(filter);
    return { deletedCount: r.deletedCount };
  }

  async aggregate(collection, pipeline = []) {
    await this.connect();
    return this.collection(collection).aggregate(pipeline, { maxTimeMS: 30000 }).toArray();
  }

  async watch(collection, onEvent, { resumeToken = null } = {}) {
    // Change streams require a replica set; error text explains that clearly.
    await this.connect();
    const col = collection ? this.collection(collection) : this.dbh;
    const stream = resumeToken ? col.watch([], { resumeAfter: resumeToken }) : col.watch([]);
    stream.on('change', (change) => onEvent(change));
    return stream;
  }

  async transaction(fn) {
    // MongoDB transactions require a replica set — the driver will surface the
    // exact error if the deployment is standalone.
    await this.connect();
    const session = this.client.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await fn(this, session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async dump() {
    await this.connect();
    const out = { generatedAt: new Date().toISOString(), collections: {} };
    for (const { name } of await this.listTables()) {
      out.collections[name] = await this.collection(name).find({}).limit(10000).toArray();
    }
    return JSON.stringify(out, null, 2);
  }
}

registerAdapter('mongodb', MongoDbAdapter);

export async function register(ctx) {
  ctx.log.debug?.('mongodb-adapter registered (driver loaded on demand)');
}
