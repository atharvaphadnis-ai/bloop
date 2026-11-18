# Migrations

Version-controlled SQL migrations live here, per project:

```
migrations/<project-slug>/17100000000000_create_users.sql
migrations/<project-slug>/17100000000000_create_users.down.sql   # optional rollback
```

## Commands

```bash
bloop db migrate <projectId>            # apply all pending migrations (checksum-tracked)
bloop db migrate <projectId> --dry-run  # preview
bloop db rollback <projectId>           # roll back the last applied migration (needs .down.sql)
bloop db rollback <projectId> --steps 2
```

Dashboard: **Database → Migrations** (create, preview, apply, rollback, drift detection).

## Semantics

- Applied migrations are recorded per connection with a SHA-256 checksum.
- If a file changes after being applied, `validate()` reports **checksum drift** —
  it is never silently re-applied.
- An empty `.down.sql` makes rollback impossible for that migration; the CLI and
  dashboard report this honestly ("rollback unavailable") instead of pretending.
- Each migration runs inside a transaction; on failure the run stops and the
  remaining migrations stay pending.
