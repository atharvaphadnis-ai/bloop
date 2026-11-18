// core/plugin-loader.js — discovers, validates and loads plugins from the
// plugins/ directory. A plugin is a folder with manifest.json + index.js
// exporting register(ctx). Enable/disable state is persisted in the system DB.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_MANIFEST_FIELDS = ['name', 'version', 'description'];
const KNOWN_PERMISSIONS = new Set([
  'routes', 'events', 'database', 'storage', 'auth', 'settings', 'network', 'filesystem',
]);

export class PluginLoader {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'plugins' });
    this.loaded = new Map(); // name -> {instance, manifest, status}
  }

  get db() { return this.ctx.system; }

  discover() {
    const dir = path.resolve(this.ctx.rootDir, this.ctx.config.get('plugins.directory', 'plugins'));
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(dir, entry.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        out.push({ dir: path.join(dir, entry.name), manifest, folder: entry.name });
      } catch (err) {
        this.log.warn(`plugin "${entry.name}" has invalid manifest.json: ${err.message}`);
      }
    }
    return out;
  }

  validateManifest(manifest) {
    const errors = [];
    for (const f of REQUIRED_MANIFEST_FIELDS) {
      if (!manifest[f]) errors.push(`missing "${f}"`);
    }
    for (const p of manifest.permissions || []) {
      if (!KNOWN_PERMISSIONS.has(p)) errors.push(`unknown permission "${p}"`);
    }
    return errors;
  }

  async loadAll() {
    const discovered = this.discover();
    for (const { dir, manifest, folder } of discovered) {
      const errors = this.validateManifest(manifest);
      if (errors.length) {
        this.log.warn(`plugin "${folder}" skipped: ${errors.join('; ')}`);
        continue;
      }
      const row = this.db.get('SELECT enabled FROM plugins_installed WHERE name = ?', [manifest.name]);
      const enabled = row ? !!row.enabled : !!this.ctx.config.get('plugins.autoEnable', false);
      if (!enabled) continue;
      try {
        await this.loadOne(dir, manifest);
      } catch (err) {
        this.log.error(`plugin "${manifest.name}" failed to load: ${err.message}`);
      }
    }
  }

  async loadOne(dir, manifest) {
    const modUrl = pathToFileURL(path.join(dir, manifest.main || 'index.js')).href;
    const mod = await import(/* @vite-ignore */ modUrl);
    if (typeof mod.register !== 'function') {
      throw new Error('plugin module must export register(ctx)');
    }
    const pluginCtx = this.makePluginContext(manifest);
    await mod.register(pluginCtx);
    this.loaded.set(manifest.name, { module: mod, manifest, dir, context: pluginCtx, status: 'loaded' });
    // persist installation record
    const existing = this.db.get('SELECT id FROM plugins_installed WHERE name = ?', [manifest.name]);
    const now = new Date().toISOString();
    if (existing) {
      this.db.run('UPDATE plugins_installed SET version = ?, path = ?, manifest_json = ?, updated_at = ? WHERE id = ?',
        [manifest.version, dir, JSON.stringify(manifest), now, existing.id]);
    } else {
      this.db.run('INSERT INTO plugins_installed (id, name, version, path, enabled, manifest_json, installed_at, updated_at) VALUES (?,?,?,?,1,?,?,?)',
        [crypto.randomUUID(), manifest.name, manifest.version, dir, JSON.stringify(manifest), now, now]);
    }
    this.log.info(`plugin loaded: ${manifest.name}@${manifest.version}`);
    return true;
  }

  makePluginContext(manifest) {
    const perms = new Set(manifest.permissions || []);
    const ctx = this.ctx;
    const pc = {
      log: ctx.log.child({ source: `plugin:${manifest.name}` }),
      bus: ctx.bus,
      config: ctx.config,
      manifest,
      hasPermission: (p) => perms.has(p),
    };
    if (perms.has('database')) pc.system = ctx.system;
    if (perms.has('routes')) pc.addRoute = (method, pattern, handler, opts) => ctx.router.add(method, pattern, handler, { ...opts, plugin: manifest.name });
    if (perms.has('settings')) pc.settings = {
      get: (key, dflt) => { const row = ctx.system.get("SELECT value_json FROM settings WHERE scope = ? AND key = ?", [`plugin:${manifest.name}`, key]); return row ? JSON.parse(row.value_json) : dflt; },
      set: (key, value) => ctx.system.run("INSERT INTO settings (scope, key, value_json, updated_at) VALUES (?,?,?,?) ON CONFLICT(scope, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        [`plugin:${manifest.name}`, key, JSON.stringify(value), new Date().toISOString()]),
    };
    return Object.freeze(pc);
  }

  async enable(name) {
    const row = this.db.get('SELECT * FROM plugins_installed WHERE name = ?', [name]);
    if (!row) throw new Error(`plugin "${name}" is not installed`);
    this.db.run('UPDATE plugins_installed SET enabled = 1, updated_at = ? WHERE name = ?', [new Date().toISOString(), name]);
    const discovered = this.discover().find((d) => d.manifest.name === name);
    if (discovered && !this.loaded.has(name)) await this.loadOne(discovered.dir, discovered.manifest);
    return { enabled: true };
  }

  disable(name) {
    const row = this.db.get('SELECT * FROM plugins_installed WHERE name = ?', [name]);
    if (!row) throw new Error(`plugin "${name}" is not installed`);
    this.db.run('UPDATE plugins_installed SET enabled = 0, updated_at = ? WHERE name = ?', [new Date().toISOString(), name]);
    const instance = this.loaded.get(name);
    if (instance?.module?.shutdown) {
      try { instance.module.shutdown(); } catch (err) { this.log.warn(`plugin ${name} shutdown hook failed: ${err.message}`); }
    }
    this.loaded.delete(name);
    return { disabled: true, restartHint: 'Some plugin routes remain registered until server restart.' };
  }

  status() {
    const installed = this.db.all('SELECT * FROM plugins_installed ORDER BY installed_at');
    return installed.map((p) => ({
      ...p,
      manifest_json: undefined,
      manifest: JSON.parse(p.manifest_json || '{}'),
      active: this.loaded.has(p.name),
    }));
  }
}

import crypto from 'node:crypto';
