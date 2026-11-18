// cli/main.js — the Bloop CLI. Local commands (init/start/stop/status/doctor)
// manage the server process directly; remote commands talk to a running
// server through /api/admin/cli/* using the bootstrap token at
// storage/system/cli-token.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
const TOKEN_FILE = path.join(ROOT, 'storage', 'system', 'cli-token');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const HELP = `
${C.bold('bloop')} — Your backend. Your rules. Your database.

${C.bold('Usage:')} bloop <command> [options]

${C.bold('Server lifecycle')}
  init                       create .env, directories and print next steps
  start [--dev] [--port N]   start the server (foreground; add --daemon to detach)
  stop                       stop a running server (PID file)
  status                     show server status (local or remote)
  restart                    stop then start
  logs [-n 50] [--level lvl] tail application logs from the server

${C.bold('Projects')}
  project create <name>      create a project (default org)
  project list               list projects
  project delete <id>        delete a project (asks confirmation)

${C.bold('Database')}
  db connect [projectId]     interactive SQL shell against the default connection
  db migrate <projectId>     apply pending migrations
  db rollback <projectId>    roll back the last migration
  db backup <projectId>      create a verified backup
  db restore <backupId>      restore a backup (new project by default)
  db seed <projectId> <file> execute a SQL file against the default connection
  db export <projectId>      print the SQL dump of the default connection
  db import <projectId> <file> execute a SQL dump against the default connection

${C.bold('Functions & plugins & SDK')}
  functions deploy <projectId> <slug> <file>   create or update a function
  functions list <projectId>                   list functions
  plugins list                                 list installed plugins
  plugins install <path>                       install a plugin folder
  sdk generate <projectId> [langs]             generate client SDKs to sdk/generated/

${C.bold('Diagnostics')}
  doctor                     run health checks against the running server
  help                       this message

${C.bold('Environment')}
  BLOOP_CLI_URL   base URL of a remote server (default http://localhost:8090)
  BLOOP_CLI_TOKEN CLI token (default: storage/system/cli-token)
`;

function parseArgs(argv) {
  const args = [];
  const opts = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'dev' || key === 'daemon') { opts[key] = true; i++; continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { opts[key] = next; i += 2; }
      else { opts[key] = true; i++; }
    } else { args.push(a); i++; }
  }
  return { args, opts };
}

function readToken() {
  if (process.env.BLOOP_CLI_TOKEN) return process.env.BLOOP_CLI_TOKEN;
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return null; }
}

function baseUrl() {
  return (process.env.BLOOP_CLI_URL || `http://localhost:${process.env.BLOOP_PORT || 8090}`).replace(/\/$/, '');
}

async function cliApi(method, apiPath, body) {
  const token = readToken();
  if (!token) throw new Error(`No CLI token found at ${TOKEN_FILE}. Is the server initialized? Start it with: bloop start`);
  const res = await fetch(baseUrl() + apiPath, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return data;
}

function pidFile() { return path.join(ROOT, 'storage', 'system', 'bloop.pid'); }
function readPid() {
  try { return parseInt(fs.readFileSync(pidFile(), 'utf8').trim(), 10); } catch { return null; }
}
function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/* ═══ local process commands ═════════════════════════════════════════════ */
async function cmdInit() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    console.log(C.yellow('.env already exists — leaving it untouched'));
  } else {
    fs.writeFileSync(envPath, fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'));
    console.log(C.green('✓ .env created from .env.example'));
  }
  for (const dir of ['storage', 'backups', 'logs']) {
    fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
  }
  console.log(C.green('✓ storage/, backups/ ready'));
  console.log('');
  console.log('Next steps:');
  console.log(`  ${C.bold('bloop start')}            # start the server (opens the dashboard on the port from .env)`);
  console.log(`  ${C.bold('open http://localhost:8090')}  # create the owner account on first visit`);
  console.log(`  ${C.bold('bloop doctor')}           # verify everything once it runs`);
}

async function cmdStart({ opts }) {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    console.log(C.yellow(`Bloop is already running (pid ${pid}) — ${baseUrl()}`));
    return;
  }

  // --daemon: launch ONE detached child that runs the server in-process.
  if (opts.daemon) {
    const env = { ...process.env };
    if (opts.port) env.BLOOP_PORT = String(opts.port);
    if (opts.dev) env.NODE_ENV = 'development';
    console.log('Starting Bloop detached…');
    const child = spawn(process.execPath, [path.join(ROOT, 'bloop.js'), 'start'], {
      cwd: ROOT,
      env,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch(`${baseUrl()}/health`);
        if (res.ok) {
          console.log(C.green(`✓ Bloop is up — dashboard: ${baseUrl()}/`));
          const token = readToken();
          if (token) console.log(C.dim(`  CLI token: ${TOKEN_FILE}`));
          return;
        }
      } catch { /* not up yet */ }
    }
    console.log(C.yellow('Server did not answer /health within 30s — check storage/logs/bloop-*.log'));
    process.exitCode = 1;
    return;
  }

  // Foreground (npm start): run the server directly in THIS process.
  // No child spawning — the previous recursive spawn was a crash loop.
  if (opts.port) process.env.BLOOP_PORT = String(opts.port);
  if (opts.dev) process.env.NODE_ENV = 'development';

  let ctx;
  try {
    const { startApp } = await import('../backend/core/app.js');
    ctx = await startApp();
  } catch (err) {
    const msg = String(err?.message || err);
    if (/EADDRINUSE/i.test(msg)) {
      console.error(C.red(`Port ${process.env.BLOOP_PORT || 8090} is already in use.`));
      console.error(C.dim('  → stop the other process first: bloop stop   (or change BLOOP_PORT in .env)'));
    } else {
      console.error(C.red(`Failed to start Bloop: ${msg}`));
      if (process.env.BLOOP_DEBUG) console.error(err?.stack);
    }
    process.exit(1);
  }
  const port = ctx.httpServer.address().port;
  console.log(C.green(`✓ Bloop is running — dashboard: http://localhost:${port}/  (press Ctrl+C to stop)`));
  // Keep the process alive; SIGINT/SIGTERM are handled by the lifecycle (graceful shutdown).
  await new Promise(() => { /* run forever */ });
}


async function cmdStop() {
  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    console.log(C.yellow('Bloop is not running (no live PID file)'));
    return;
  }
  process.kill(pid, 'SIGTERM');
  console.log(`Sent SIGTERM to pid ${pid} — waiting for graceful shutdown…`);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (!isRunning(pid)) { console.log(C.green('✓ Bloop stopped')); return; }
  }
  console.log(C.yellow('Still running — sending SIGKILL'));
  try { process.kill(pid, 'SIGKILL'); } catch { }
  console.log(C.green('✓ Killed'));
}

async function cmdStatus() {
  const pid = readPid();
  const local = pid && isRunning(pid) ? C.green(`running (pid ${pid})`) : C.red('not running locally');
  console.log(`Local process: ${local}`);
  try {
    const status = await cliApi('GET', '/api/admin/cli/status');
    console.log(`Server:       v${status.version} · uptime ${Math.floor(status.uptimeSec / 60)}m · ${status.projects} projects`);
    console.log(`Dashboard:    ${baseUrl()}/`);
    console.log(`Admin setup:  ${status.adminConfigured ? 'done' : C.yellow('pending — open the dashboard to create the owner account')}`);
  } catch (err) {
    console.log(C.red(`Server unreachable: ${err.message}`));
  }
}

/* ═══ remote commands ════════════════════════════════════════════════════ */
async function cmdDoctor() {
  const d = await cliApi('GET', '/api/admin/cli/doctor');
  for (const check of d.checks) {
    console.log(` ${check.ok ? C.green('✓') : C.red('✗')} ${check.name}${check.detail ? C.dim(` — ${check.detail}`) : ''}`);
  }
  console.log(d.ok ? C.green('\nAll checks passed.') : C.red('\nSome checks failed — see hints above.'));
  process.exitCode = d.ok ? 0 : 1;
}

async function cmdLogs(opts) {
  const n = Number(opts.opts?.n || 50);
  const data = await cliApi('GET', `/api/admin/cli/logs?limit=${n}${opts.opts?.level ? `&level=${opts.opts.level}` : ''}`);
  for (const log of (data.logs || []).reverse()) {
    const color = log.level === 'error' ? C.red : log.level === 'warn' ? C.yellow : C.dim;
    console.log(`${C.dim(log.ts.slice(11, 19))} ${color(log.level.toUpperCase().padEnd(5))} ${log.msg}`);
  }
}

async function cmdProject(action, arg) {
  if (action === 'create') {
    if (!arg) throw new Error('Usage: bloop project create <name>');
    const p = await cliApi('POST', '/api/admin/cli/projects', { name: arg });
    console.log(C.green(`✓ Project “${p.name}” created`));
    console.log(`  id:      ${p.id}`);
    console.log(`  slug:    ${p.slug}`);
    console.log(`  envs:    ${(p.environments || []).map((e) => e.name).join(', ')}`);
    console.log(C.dim('  keys:    displayed once — check the dashboard (Connect button)'));
    return;
  }
  if (action === 'list') {
    const { projects } = await cliApi('GET', '/api/admin/cli/projects');
    if (!projects.length) { console.log(C.dim('No projects yet — create one: bloop project create my-app')); return; }
    for (const p of projects) {
      console.log(` ${C.bold(p.name)} ${C.dim(p.slug)} ${C.dim(p.id)} ${p.status}`);
    }
    return;
  }
  if (action === 'delete') {
    if (!arg) throw new Error('Usage: bloop project delete <projectId>');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((r) => rl.question(`Type the project id to confirm deletion (${arg}): `, r));
    rl.close();
    if (answer.trim() !== arg) { console.log(C.red('Aborted — id did not match')); process.exitCode = 1; return; }
    await cliApi('POST', `/api/admin/cli/projects/${arg}/delete`, { confirm: true });
    console.log(C.green('✓ Project deleted'));
    return;
  }
  throw new Error(`Unknown project action "${action}" (create | list | delete)`);
}

async function cmdDb(action, args, opts) {
  const projectId = args[0];
  if (action === 'connect') {
    await dbConnectShell(projectId);
    return;
  }
  if (action === 'migrate') {
    const r = await cliApi('POST', '/api/admin/cli/db/migrate', { projectId, dryRun: opts.dryRun === true });
    for (const res of r.results || []) {
      console.log(` ${res.status === 'applied' ? C.green('✓') : res.status === 'failed' ? C.red('✗') : C.dim('·')} ${res.filename} ${res.error ? C.red(res.error) : ''}`);
    }
    console.log(C.green(`${r.applied} migration(s) applied`));
    return;
  }
  if (action === 'rollback') {
    const r = await cliApi('POST', '/api/admin/cli/db/rollback', { projectId, steps: Number(opts.steps || 1), dryRun: opts.dryRun === true });
    for (const res of r.results || []) {
      console.log(` ${res.status === 'rolled-back' ? C.green('✓') : C.red('✗')} ${res.filename} ${res.reason ? C.yellow(res.reason) : res.error ? C.red(res.error) : ''}`);
    }
    return;
  }
  if (action === 'backup') {
    const b = await cliApi('POST', '/api/admin/cli/db/backup', { projectId, name: opts.name, destination: opts.destination || 'local' });
    console.log(C.green(`✓ Backup verified: ${b.name}`));
    console.log(`  status: ${b.status} · size: ${(b.size / 1024).toFixed(1)} KB · entries: ${b.entries}`);
    console.log(`  id:     ${b.id}`);
    return;
  }
  if (action === 'restore') {
    const backupId = args[0];
    if (!backupId) throw new Error('Usage: bloop db restore <backupId>');
    const r = await cliApi('POST', '/api/admin/cli/db/restore', { backupId, mode: opts['new-project'] === false ? 'in-place' : 'new-project' });
    console.log(C.green('✓ Restore completed'));
    console.log(`  job: ${r.jobId} → project ${r.projectId}`);
    return;
  }
  if (action === 'seed' || action === 'import') {
    const file = args[1];
    if (!projectId || !file) throw new Error(`Usage: bloop db ${action} <projectId> <file.sql>`);
    const sql = fs.readFileSync(path.resolve(file), 'utf8');
    const r = await cliApi('POST', '/api/admin/cli/db/seed', { projectId, sql });
    console.log(C.green(`✓ Executed (${r.results?.length ?? 1} statement batch)`));
    return;
  }
  if (action === 'export') {
    const r = await cliApi('POST', '/api/admin/cli/db/export', { projectId });
    if (args[1]) fs.writeFileSync(path.resolve(args[1]), r.dump, 'utf8');
    else console.log(r.dump);
    console.error(C.dim(args[1] ? `✓ Dump written to ${args[1]}` : ''));
    return;
  }
  throw new Error(`Unknown db action "${action}"`);
}

async function dbConnectShell(projectId) {
  const { projects } = await cliApi('GET', '/api/admin/cli/projects');
  let target = projectId || projects[0]?.id;
  if (!target) throw new Error('No projects — create one first: bloop project create my-app');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'bloop-sql> ' });
  console.log(C.dim(`Interactive SQL shell — project ${target}. Exit with .quit or Ctrl+C`));
  rl.prompt();
  rl.on('line', async (line) => {
    const sql = line.trim();
    if (!sql) return rl.prompt();
    if (sql === '.quit' || sql === '.exit') { rl.close(); return; }
    if (sql.startsWith('.project')) {
      target = sql.split(/\s+/)[1] || target;
      console.log(C.dim(`project → ${target}`));
      return rl.prompt();
    }
    try {
      const r = await cliApi('POST', '/api/admin/cli/db/seed', { projectId: target, sql });
      for (const res of r.results || []) {
        if (res.status === 'error') console.log(C.red(`error: ${res.error}`));
        else if (res.rows?.length) console.table(res.rows.slice(0, 50));
        else console.log(C.dim(`ok (${res.rowCount ?? 0} rows)`));
      }
    } catch (err) {
      console.log(C.red(`error: ${err.message}`));
    }
    rl.prompt();
  });
  rl.on('close', () => console.log(C.dim('bye')));
}

async function cmdFunctions(action, args) {
  const projectId = args[0];
  if (action === 'deploy') {
    const [, slug, file] = args;
    if (!projectId || !slug || !file) throw new Error('Usage: bloop functions deploy <projectId> <slug> <function.js>');
    const code = fs.readFileSync(path.resolve(file), 'utf8');
    const r = await cliApi('POST', '/api/admin/cli/functions/deploy', { projectId, slug, code });
    console.log(C.green(`✓ Function "${slug}" ${r.created ? 'created' : 'updated'}`));
    console.log(C.dim(`  invoke: POST ${baseUrl()}/api/v1/${projectId}/functions/${slug}`));
    return;
  }
  if (action === 'list') {
    const { functions } = await cliApi('GET', `/api/admin/cli/functions/list?projectId=${projectId}`);
    if (!functions.length) { console.log(C.dim('No functions')); return; }
    for (const f of functions) {
      console.log(` ${f.enabled ? C.green('●') : C.dim('○')} ${C.bold(f.slug)} ${C.dim(`${f.timeout_ms}ms · ${(f.triggers || []).length} triggers`)}`);
    }
    return;
  }
  throw new Error(`Unknown functions action "${action}" (deploy | list)`);
}

async function cmdPlugins(action, arg) {
  if (action === 'list') {
    const { plugins } = await cliApi('GET', '/api/admin/cli/plugins');
    if (!plugins.length) { console.log(C.dim('No plugins installed — example: plugins/hello-bloop')); return; }
    for (const p of plugins) {
      console.log(` ${p.enabled ? C.green('●') : C.dim('○')} ${C.bold(p.name)}@${p.version} ${p.active ? C.green('(loaded)') : C.dim('(registered, not loaded)')}`);
    }
    return;
  }
  if (action === 'install') {
    const r = await cliApi('POST', '/api/admin/cli/plugins/install', { path: path.resolve(arg || ''), enable: true });
    console.log(C.green(`✓ ${r.installed ? 'Installed' : 'Registered'}: ${r.name || r.plugin || 'plugin'}`));
    return;
  }
  throw new Error(`Unknown plugins action "${action}" (list | install)`);
}

async function cmdSdk(args) {
  const projectId = args[0];
  if (!projectId) throw new Error('Usage: bloop sdk generate <projectId> [javascript,typescript,python,go,dart]');
  const languages = args[1] ? args[1].split(',').map((s) => s.trim()) : undefined;
  const r = await cliApi('POST', '/api/admin/cli/sdk/generate', { projectId, languages });
  console.log(C.green('✓ SDKs generated to ' + r.outDir));
  for (const f of r.files || []) console.log(C.dim(`  ${f}`));
}

/* ═══ dispatcher ═════════════════════════════════════════════════════════ */
export async function runCli(argv) {
  const { args, opts } = parseArgs(argv);
  const command = args[0] || 'help';

  const needsServer = ['status', 'doctor', 'logs', 'project', 'db', 'functions', 'plugins', 'sdk'];
  try {
    switch (command) {
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        return;
      case 'init': return await cmdInit();
      case 'start':
        return await cmdStart({ opts });
      case 'stop': return await cmdStop();
      case 'restart':
        await cmdStop();
        await new Promise((r) => setTimeout(r, 800));
        return await cmdStart({ opts });
      case 'status': return await cmdStatus();
      case 'doctor': return await cmdDoctor();
      case 'logs': return await cmdLogs({ opts });
      case 'project': return await cmdProject(args[1], args[2], opts);
      case 'db': return await cmdDb(args[1], args.slice(2), opts);
      case 'functions': return await cmdFunctions(args[1], args.slice(2));
      case 'plugins': return await cmdPlugins(args[1], args[2]);
      case 'sdk': return await cmdSdk(args.slice(1));
      case 'version':
        console.log(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
        return;
      default:
        console.error(C.red(`Unknown command "${command}"`));
        console.log(HELP);
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(C.red(`error: ${err.message}`));
    if (needsServer.includes(command) && err.message.includes('token')) {
      console.error(C.dim(`hint: start the server first (bloop start) or set BLOOP_CLI_TOKEN / BLOOP_CLI_URL`));
    }
    process.exitCode = 1;
  }
}
