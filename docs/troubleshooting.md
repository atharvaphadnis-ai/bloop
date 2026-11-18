# Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `node:sqlite` error on start | Node < 22.5 — upgrade Node (>= 22.5 required) |
| Port 8090 busy | `BLOOP_PORT` in `.env`, or `bloop stop` (leftover PID file → `storage/system/bloop.pid`) |
| "PostgreSQL support requires the optional pg driver" | install on the server: `npm install pg` (same for `mysql2`, `mongodb`) |
| "BadgerDB sidecar … unreachable" | start the sidecar: `docker compose --profile badger up -d`, then point the connection at `http://localhost:8089` |
| Dashboard login locked | brute-force lockout — wait (exponential, ≤ 15 min) or restart the server |
| SMTP token returned instead of emailed | SMTP not configured for the project — configure it under Authentication → Email; tokens are clearly labeled development-mode |
| Image transform returns 501 | optional `sharp` not installed — `npm install sharp` |
| Encrypted backup won't restore | different master key — restore on the instance holding the original `storage/system/secret.key` |
| Webhook not delivered | check the Delivery log (status, HTTP code, next retry); verify `X-Bloop-Signature` with the webhook's secret; retries use exponential backoff |
| Migration rollback says "blocked" | the `.down.sql` is empty/missing — fill it, or write an inverse migration |
| Logs filling disk | retention prunes daily (default 14 d, `BLOOP_LOG_RETENTION_DAYS`); schedule a `cleanup` job |
| Reset everything | stop the server, remove `storage/` (destroys all data!) |
