# CLI guide

`node bloop.js <command>` (or `bloop` if linked). Talks to a running server using the bootstrap token at `storage/system/cli-token` (override with `BLOOP_CLI_TOKEN` / `BLOOP_CLI_URL`).

```
init                     scaffold .env + directories
start [--daemon|--dev|--port N] · stop · restart · status
doctor                   live health checks
logs [-n 50] [--level error]
project create|list|delete
db connect [projectId]   interactive SQL shell (RLS-free, admin path)
db migrate|rollback [projectId] [--dry-run] [--steps N]
db backup|restore · db seed|export|import
functions deploy|list    plugins list|install    sdk generate
```

Examples:
```bash
bloop project create my-app
bloop functions deploy <pid> greeter ./greeter.js
bloop db backup <pid>
bloop sdk generate <pid> javascript,python
```
Every command prints honest errors with next-step hints (e.g. missing server, wrong token).
