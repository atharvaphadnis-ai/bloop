# Self-hosting guide

## Plain Node
```bash
npm start                 # foreground
node bloop.js start --daemon   # detached (PID file at storage/system/bloop.pid)
node bloop.js stop
```

## HTTPS / reverse proxy
Bloop serves HTTP; terminate TLS at your proxy (nginx/Caddy/Traefik) and forward to `127.0.0.1:8090`. Recommended headers are already set by the app (HSTS, nosniff, DENY frames). Example nginx:
```
location / {
  proxy_pass http://127.0.0.1:8090;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;      # required for /realtime/v1
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 300s;
}
```
Set `server.publicOrigin` in `config/config.json` (or your proxy origin) so OAuth redirects, email links and signed URLs use the public address.

## Backups & DR
- Manual or scheduled (cron) backups; artifact = ZIP (project bundle + SQLite snapshot or SQL dump + storage files + manifest), optional AES-256-GCM encryption, sha256 checksum, **verification before success is reported**.
- Destinations: local `backups/` or S3 (per-project or platform credentials).
- Restore to a new project or in-place (automatic safety backup first). Restore-test restores into a disposable project and verifies counts.
- DR plan: `GET /api/admin/dr/plan`. Keep `storage/system/secret.key` safe — encrypted backups need it.

## Updates
Stop → replace the source folder → start. The system schema migrates itself; user data lives in `storage/` and `backups/` (git-ignored).
