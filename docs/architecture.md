# Architecture

Modular monolith: one process, async I/O everywhere, strict layering.

```
bloop.js ──▶ cli/main.js            CLI (spawns the server or talks HTTP to it)
backend/core/app.js                 composition root: builds ctx, wires lifecycle
  core/     environment → config → logger → event-bus → router/middleware →
            project/tenant/environment managers → permission/policy engines →
            health, lifecycle, plugin-loader, module-loader, server
  modules/  adapters (sqlite/pg/mysql/mariadb/mongo/badger) → connection-pool →
            database (system store + connection manager) → migrations, branching,
            sql-editor, nosql-engine → authentication, authorization → rest-api,
            graphql, realtime, storage, functions
  infrastructure/  security (master key, AES-GCM, admin JWT) → metrics, tracing,
            observability, audit-logs → email, oauth, webhooks, scheduler, s3 →
            backups, backup-scheduler, disaster-recovery, cdc → cli-service,
            sdk-generator, docker-manager, import-manager, plugin-marketplace →
            admin-api (dashboard API, mounted last)
```

**Context object (`ctx`)** — every module receives `ctx` and attaches itself (`ctx.database`, `ctx.authentication`, …). Startup order is explicit (`module-loader.js` lists files; route-mounting is a second pass after all services exist).

**System store** — one SQLite file (`storage/system/bloop-system.db`) holds platform metadata (orgs, projects, users, keys, logs…). Project data lives in project databases (embedded SQLite file per project, or an external provider).

**Event bus** — normalized change events (`db.insert|update|delete`, `auth.*`, `storage.*`, `project.*`) fan out to realtime, webhooks, function triggers, audit entries and plugins. `emitAwait` orders CDC fan-out before HTTP responses return.

**Request pipeline** — request-context → security headers → CORS → access log/metrics/tracing → rate limit → body parse (JSON/urlencoded/text/multipart, hard size cap) → route match → auth guard (`public` / `admin` / `project` / `cli`) → handler → central error middleware (typed AppErrors, redaction, request IDs).

**Isolation** — functions run in Worker threads with a `vm` sandbox (no require/process/fs; timeouts + resource limits). Passkeys implement CBOR + COSE + ES256 verification directly on `node:crypto`. ZIP read/write, SigV4, SMTP, GraphQL parser/executor, WebSocket frames: all implemented in-repo, zero dependencies.

**Frontend** — 18-file vanilla SPA: hash router, component kit, permission-aware admin API client, dark/light theme, command palette (Ctrl-K). No framework, no build step.
