// core/lifecycle.js — ordered startup/shutdown orchestration with named steps,
// PID file and POSIX signal handling.
import fs from 'node:fs';
import path from 'node:path';

export class Lifecycle {
  constructor(ctx) {
    this.ctx = ctx;
    this.initSteps = [];   // [{name, fn}]
    this.shutdownSteps = [];
    this.running = false;
    this.shuttingDown = false;
  }

  registerInit(name, fn) {
    this.initSteps.push({ name, fn });
    return this;
  }

  registerShutdown(name, fn) {
    this.shutdownSteps.push({ name, fn });
    return this;
  }

  async init() {
    const started = Date.now();
    for (const step of this.initSteps) {
      const t0 = Date.now();
      try {
        await step.fn();
        this.ctx.log.debug(`lifecycle: ${step.name} ok (${Date.now() - t0}ms)`);
      } catch (err) {
        this.ctx.log.error(`lifecycle: ${step.name} FAILED: ${err.message}`, { stack: err.stack });
        throw new Error(`Startup failed at step "${step.name}": ${err.message}`);
      }
    }
    this.running = true;
    this.writePidFile();
    this.ctx.log.info(`bloop started in ${Date.now() - started}ms (${this.initSteps.length} init steps)`);
  }

  writePidFile() {
    try {
      const dir = path.join(this.ctx.env.dataDir, 'system');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'bloop.pid'), String(process.pid), 'utf8');
    } catch { /* non-fatal */ }
  }

  async shutdown(reason = 'signal') {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.ctx.log.warn(`bloop shutting down (${reason})`);
    this.running = false;
    for (const step of this.shutdownSteps.reverse()) {
      try {
        await Promise.race([
          Promise.resolve(step.fn()),
          new Promise((resolve) => setTimeout(resolve, 8000)),
        ]);
      } catch (err) {
        this.ctx.log.error(`lifecycle shutdown step "${step.name}" failed: ${err.message}`);
      }
    }
    try { fs.rmSync(path.join(this.ctx.env.dataDir, 'system', 'bloop.pid'), { force: true }); } catch { }
    this.ctx.log.info('bloop stopped cleanly');
  }

  installSignalHandlers() {
    const signals = ['SIGINT', 'SIGTERM'];
    let handled = 0;
    for (const sig of signals) {
      process.on(sig, () => {
        handled++;
        if (handled > 1) {
          this.ctx.log.warn('second termination signal — forcing exit');
          process.exit(1);
        }
        this.shutdown(sig).then(() => process.exit(0)).catch(() => process.exit(1));
      });
    }
    process.on('unhandledRejection', (err) => {
      this.ctx.log.error('unhandledRejection', { message: err?.message, stack: err?.stack?.split('\n').slice(0, 6) });
    });
    process.on('uncaughtException', (err) => {
      this.ctx.log.error('uncaughtException', { message: err?.message, stack: err?.stack?.split('\n').slice(0, 6) });
    });
  }
}
