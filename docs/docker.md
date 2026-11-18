# Docker guide

```bash
docker compose up -d                          # Bloop only (embedded SQLite)
docker compose --profile postgres up -d       # + PostgreSQL
docker compose --profile mongo up -d          # + MongoDB (replica-set mode for change streams)
docker compose --profile minio up -d          # + MinIO (S3-compatible storage)
docker compose --profile badger up -d         # + BadgerDB sidecar (Go bridge)
```

- Persistent volumes: `bloop_storage` (data/uploads/system DB/secret key), `bloop_backups`, plus per-provider volumes.
- Health checks on every service; restart policy `unless-stopped`.
- Set `BLOOP_SECRET` in production (compose comment shows where) or keep the generated `storage/system/secret.key` inside the volume — losing it means losing encrypted secrets.
- The BadgerDB sidecar is the only Go component (isolated compatibility bridge, as documented); build it with `docker compose build badger`. A `go.sum` is generated during its container build.
- Provider-generated snippets: dashboard → Settings → Docker providers, or `POST /api/admin/docker/compose`.
