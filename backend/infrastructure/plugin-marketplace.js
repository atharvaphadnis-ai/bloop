// infrastructure/plugin-marketplace.js — local-first plugin registry with an
// optional remote marketplace endpoint. The marketplace ships EMPTY by design
// (never pretend a registry is populated); local installation from a folder
// or a .zip archive works fully offline.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { badRequest, notFound } from '../core/error-handler.js';
import { readZip } from './sdk-generator.js';

export class PluginMarketplace {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'marketplace' });
  }

  get loader() { return this.ctx.pluginLoader; }

  /**
   * Local plugins from plugins/ + installed state. If a remote registry URL
   * is configured in settings, it is queried; otherwise the remote list is
   * honestly empty.
   */
  async catalog() {
    const discovered = this.loader.discover().map((d) => ({
      name: d.manifest.name,
      version: d.manifest.version,
      description: d.manifest.description,
      permissions: d.manifest.permissions || [],
      folder: d.folder,
      source: 'local',
      installed: true,
      enabled: !!this.ctx.system.get('SELECT enabled FROM plugins_installed WHERE name = ?', [d.manifest.name])?.enabled,
    }));
    const registryUrl = this.ctx.security.settingsGet('plugins', 'registryUrl', null);
    let remote = [];
    let remoteNote = 'No remote registry configured. Local installation works independently of any external service.';
    if (registryUrl) {
      try {
        const r = await fetch(`${registryUrl.replace(/\/$/, '')}/plugins`, { signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const data = await r.json();
          remote = (data.plugins || []).map((p) => ({ ...p, source: 'registry' }));
          remoteNote = `Remote registry: ${registryUrl}`;
        } else {
          remoteNote = `Remote registry ${registryUrl} returned ${r.status}`;
        }
      } catch (err) {
        remoteNote = `Remote registry unreachable: ${err.message}`;
      }
    }
    return { local: discovered, remote, remoteNote, installed: this.loader.status() };
  }

  /**
   * Shape consumed by the dashboard Plugins page: a flat `plugins` array —
   * the local catalog first, then registry entries not already installed —
   * plus the configured registry URL for the card subtitle. Without this
   * method GET /api/admin/marketplace threw TypeError → 500 and the whole
   * Plugins page failed to render.
   */
  async list() {
    const { local, remote, remoteNote } = await this.catalog();
    const installedRows = this.loader.status();
    const byName = new Map(installedRows.map((p) => [p.name, p]));
    const plugins = [...local, ...remote.filter((p) => !byName.has(p.name))];
    for (const p of plugins) {
      const row = byName.get(p.name);
      if (row) {
        p.installed = true;
        p.enabled = !!row.enabled;
        p.active = !!row.active;
        p.description = p.description || row.manifest?.description || '';
        p.version = p.version || row.manifest?.version || row.version;
        p.permissions = p.permissions || row.manifest?.permissions || [];
      }
    }
    const remoteRegistry = this.ctx.security.settingsGet('plugins', 'registryUrl', null);
    return { plugins, remoteRegistry, remoteNote };
  }

  async installFromPath(sourcePath, { enable = true } = {}) {
    const resolved = path.resolve(sourcePath);
    if (!fs.existsSync(resolved)) throw notFound(`Plugin source not found: ${resolved}`);
    const manifest = await this._readManifest(resolved);
    const errors = this.loader.validateManifest(manifest);
    if (errors.length) throw badRequest(`Invalid plugin manifest: ${errors.join('; ')}`);
    const dest = path.join(this.ctx.rootDir, 'plugins', manifest.name);
    if (resolved !== dest) {
      fs.rmSync(dest, { recursive: true, force: true });
      await fsp.cp(resolved, dest, { recursive: true });
    }
    if (enable) await this.loader.enable(manifest.name).catch(async () => {
      // not yet registered in DB → load directly
      await this.loader.loadOne(dest, manifest);
    });
    this.ctx.audit?.record({ actor: 'system', action: 'plugin.install', target: manifest.name, meta: { version: manifest.version } });
    return { installed: manifest.name, version: manifest.version, enabled: enable };
  }

  async installFromZip(zipBuffer, { enable = true } = {}) {
    const entries = readZip(zipBuffer);
    if (!entries.length) throw badRequest('ZIP archive is empty');
    // manifest at root or one level deep
    const manifestEntry = entries.find((e) => e.path === 'manifest.json')
      || entries.find((e) => e.path.endsWith('/manifest.json'));
    if (!manifestEntry) throw badRequest('ZIP must contain a manifest.json at its root');
    const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
    const errors = this.loader.validateManifest(manifest);
    if (errors.length) throw badRequest(`Invalid plugin manifest: ${errors.join('; ')}`);
    const baseDir = manifestEntry.path === 'manifest.json' ? '' : manifestEntry.path.replace('manifest.json', '');
    const dest = path.join(this.ctx.rootDir, 'plugins', manifest.name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    for (const e of entries) {
      if (!e.path.startsWith(baseDir) || e.path === manifestEntry.path) continue;
      const rel = e.path.slice(baseDir.length);
      const out = path.join(dest, rel);
      if (!out.startsWith(dest)) continue; // zip-slip protection
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, e.data);
    }
    if (enable) {
      try { await this.loader.enable(manifest.name); } catch {
        await this.loader.loadOne(dest, manifest);
      }
    }
    return { installed: manifest.name, version: manifest.version, enabled: enable };
  }

  async _readManifest(dir) {
    const p = path.join(dir, 'manifest.json');
    if (!fs.existsSync(p)) throw badRequest('Plugin folder must contain manifest.json');
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  }

  async uninstall(name) {
    const row = this.ctx.system.get('SELECT * FROM plugins_installed WHERE name = ?', [name]);
    if (!row) throw notFound('Plugin is not installed');
    this.loader.disable(name);
    this.ctx.system.run('DELETE FROM plugins_installed WHERE name = ?', [name]);
    const dir = path.join(this.ctx.rootDir, 'plugins', name);
    await fsp.rm(dir, { recursive: true, force: true });
    return { uninstalled: name, restartHint: 'Routes registered by the plugin disappear on restart.' };
  }

  async enable(name) { return this.loader.enable(name); }

  async disable(name) { return this.loader.disable(name); }

  pluginConfigSchema(name) {
    const discovered = this.loader.discover().find((d) => d.manifest.name === name);
    if (!discovered) throw notFound('Plugin not found in plugins/ directory');
    return discovered.manifest.config || [];
  }

  async setPluginConfig(name, values) {
    const existing = this.ctx.system.get('SELECT config_json FROM plugins_installed WHERE name = ?', [name]);
    if (!existing) throw notFound('Plugin is not installed');
    const current = JSON.parse(existing.config_json || '{}');
    for (const [k, v] of Object.entries(values)) {
      current[k] = /secret|password|token|key/i.test(k) ? this.ctx.security.encrypt(String(v)) : v;
    }
    this.ctx.system.run('UPDATE plugins_installed SET config_json = ?, updated_at = ? WHERE name = ?',
      [JSON.stringify(current), new Date().toISOString(), name]);
    return { updated: Object.keys(values).length };
  }

  getPluginConfig(name) {
    const row = this.ctx.system.get('SELECT config_json FROM plugins_installed WHERE name = ?', [name]);
    if (!row) throw notFound('Plugin is not installed');
    const config = JSON.parse(row.config_json || '{}');
    const out = {};
    for (const [k, v] of Object.entries(config)) {
      out[k] = typeof v === 'string' && v.startsWith('enc:v1:') ? '••••••••' : v;
    }
    return out;
  }
}

export async function register(ctx) {
  ctx.marketplace = new PluginMarketplace(ctx);
}
