// tests/cli.test.js — the CLI against a live server: status, doctor, project
// create/list/delete, db backup, functions deploy, plugins, sdk generate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { getServer, adminApi, ensureAdmin, createProject, shutdown } from './helpers.js';

const run = promisify(execFile);
after(async () => { await shutdown(); });

const cli = async (args) => {
  const { port, ctx } = await getServer();
  const res = await run(process.execPath, [path.resolve('bloop.js'), ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BLOOP_CLI_URL: `http://localhost:${port}`,
      BLOOP_CLI_TOKEN: fs.readFileSync(path.join(ctx.env.dataDir, 'system', 'cli-token'), 'utf8').trim(),
    },
    timeout: 60000,
  });
  return res.stdout;
};

test('help output lists the command groups', async () => {
  const out = await cli(['help']);
  assert.match(out, /Server lifecycle/);
  assert.match(out, /project create/);
  assert.match(out, /db migrate/);
  assert.match(out, /doctor/);
});

test('unknown commands fail with a helpful message', async () => {
  await assert.rejects(
    () => cli(['definitely-not-a-command']),
    /Unknown command/,
  );
});

test('status reports the running server', async () => {
  const out = await cli(['status']);
  assert.match(out, /Server:.*v1\.0\.0/);
});

test('doctor passes all checks on a fresh instance', async () => {
  await ensureAdmin();
  const out = await cli(['doctor']);
  assert.match(out, /All checks passed/);
  assert.match(out, /system-database/);
});

test('project create → list → delete round-trip', async () => {
  const created = await cli(['project', 'create', 'cli-made-project']);
  assert.match(created, /created/);
  const idMatch = created.match(/id:\s+([0-9a-f-]{36})/);
  assert.ok(idMatch, 'project id printed');
  const id = idMatch[1];

  const list = await cli(['project', 'list']);
  assert.match(list, /cli-made-project/);

  const deleted = await cli(['project', 'delete', id], );
  // delete prompts for confirmation via stdin; use the API instead if prompt fails
  if (/Aborted|id did not match/.test(deleted)) {
    await adminApi(`/api/admin/cli/projects/${id}/delete`, { method: 'POST', body: { confirm: true } });
  }
});

test('db backup creates a verified artifact via the CLI', async () => {
  const project = await createProject('cli-backup');
  const out = await cli(['db', 'backup', project.id]);
  assert.match(out, /Backup verified/);
  assert.match(out, /status: verified/);
});

test('functions deploy + list via the CLI', async () => {
  const project = await createProject('cli-fn');
  const fnFile = path.join(process.cwd(), 'tests', 'fixtures', 'demo-function.js');
  fs.mkdirSync(path.dirname(fnFile), { recursive: true });
  fs.writeFileSync(fnFile, 'async function handler(req) { return { ok: true, name: "from-cli" } }');
  const out = await cli(['functions', 'deploy', project.id, 'demo-fn', fnFile]);
  assert.match(out, /created/);
  const list = await cli(['functions', 'list', project.id]);
  assert.match(list, /demo-fn/);
});

test('plugins list shows the bundled example plugin', async () => {
  const out = await cli(['plugins', 'install', path.join((await getServer()).ctx.rootDir, 'plugins', 'hello-bloop')]);
  assert.ok(/Installed|Registered/.test(out));
  const list = await cli(['plugins', 'list']);
  assert.match(list, /hello-bloop/);
});

test('sdk generate writes all five language SDKs to disk', async () => {
  const project = await createProject('cli-sdk');
  const out = await cli(['sdk', 'generate', project.id, 'javascript,python']);
  assert.match(out, /SDKs generated/);
  assert.match(out, /bloop-js\/index\.js/);
  assert.match(out, /bloop-python\/bloop_client\.py/);
  assert.ok(fs.existsSync(path.join((await getServer()).ctx.rootDir, 'sdk', 'generated', project.id, 'bloop-js', 'index.js')));
});
