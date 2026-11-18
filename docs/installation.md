# Installation

## Requirements
- Node.js **>= 22.5** (uses the built-in `node:sqlite`). Check with `node --version`.
- No database server required to start — embedded SQLite is the default.
- Optional drivers for external providers: `npm install pg mysql2 mongodb sharp`.

## Steps
1. Unzip the release and enter the folder.
2. `npm install` (installs nothing — Bloop has zero runtime dependencies; it only validates the environment).
3. `npm start` (or `node bloop.js start`). The dashboard opens on `http://localhost:8090`.
4. First visit shows the **owner setup** form — create your admin account. No default credentials exist anywhere.
5. Create a project. Bloop provisions: a default SQLite connection, dev/staging/prod environments, anon + service API keys.

## Configuration
- Environment: copy `.env.example` to `.env` (host, port, log level, master secret, limits).
- File: `config/config.json` overrides `config/default-config.json`; editable from Settings → Edit config file (validated before apply).
- Secrets: if `BLOOP_SECRET` is unset, a strong key is generated at `storage/system/secret.key` (chmod 600). **Back that file up** — it protects all encrypted values and encrypted backups.

## Verify
```bash
npm test          # runs the automated test suites
bloop doctor      # live health checks against the running server
curl localhost:8090/health
```
