# Database providers

| Provider | Status | Driver | Notes |
|---|---|---|---|
| SQLite | default, embedded | built-in (`node:sqlite`) | WAL mode, parameterized queries, transactions (savepoint-serialized), `EXPLAIN QUERY PLAN`, `VACUUM INTO` snapshots, SQL dumps |
| PostgreSQL | supported | `npm install pg` | information_schema introspection, transactions, `EXPLAIN`, LISTEN/NOTIFY CDC (installable triggers) |
| MySQL / MariaDB | supported | `npm install mysql2` | information_schema introspection, transactions, `EXPLAIN`; binlog CDC not provided (labeled honestly) |
| MongoDB | supported | `npm install mongodb` | real collections/aggregation/indexes/change streams (replica set needed for streams + transactions) |
| BadgerDB | optional | `docker/badger-sidecar` (Go bridge) | KV operations get/put/delete/scan/count over HTTP; no SQL by design |

## Management
Dashboard **Database** page: create/test connections (test before save), health monitoring (60s), set default, edit, delete, schema browser (columns/indexes/FKs, size), row browser with editing, relationships list, RLS policies, branching, migrations. Provider capabilities are surfaced per connection — the UI never claims a capability the provider lacks.

## Branching (per provider)
SQLite → file clone · PostgreSQL → `CREATE DATABASE … TEMPLATE` (fallback dump-clone) · MySQL/MariaDB → dump-clone · MongoDB → namespace clone · Badger → unsupported (reported). Compare + additive-only sync + explicit promote.

## Migrations
`migrations/<project-slug>/NNN_name.sql` + optional `.down.sql`. Checksum-tracked; drift reported; empty down files block rollback honestly (never fake success).
