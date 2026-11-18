#!/usr/bin/env node
// bloop.js — Bloop CLI entry point.
// Usage: node bloop.js <command> [...options]
// All command implementations live in ./cli/main.js
import { runCli } from './cli/main.js';

runCli(process.argv.slice(2)).catch((err) => {
  console.error('bloop: unexpected failure:', err?.message || err);
  if (process.env.BLOOP_DEBUG) console.error(err?.stack || err);
  process.exitCode = 1;
});
