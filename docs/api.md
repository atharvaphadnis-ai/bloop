# API guide

Base URL: `http://localhost:8090`. Project APIs live under `/api/v1/<projectId>/…` and accept `Authorization: Bearer <user JWT | api key>` (the anon key grants policy-gated read access; the service key bypasses row security).

## Auto REST
```
GET    /api/v1/<pid>/db/<table>?status=eq.published&order=created_at.desc&limit=20&offset=0&count=exact
GET    /api/v1/<pid>/db/<table>/<pk>
POST   /api/v1/<pid>/db/<table>              # single object or array
PATCH  /api/v1/<pid>/db/<table>?col=eq.val   # filter required — mass updates blocked
PUT    /api/v1/<pid>/db/<table>              # upsert by primary key
DELETE /api/v1/<pid>/db/<table>/<pk>
GET    /api/v1/<pid>/openapi.json            # live OpenAPI 3.0 document
```
Operators: `eq neq gt gte lt lte like in is`. `select=` narrows columns; `embed=<table>` joins one FK relationship.

## GraphQL
`POST /api/v1/<pid>/graphql` — queries (`posts(limit, offset, where, order)`, `postsByPk(pk)`), mutations (`insertPosts(objects)`, `updatePosts(where, set)`, `deletePosts(where)`), variables, fragments, aliases, relationships, introspection (`__schema`, `__type`). Subscriptions answer with a spec-style error pointing at the Realtime engine.

## Auth endpoints
`/auth/register · /auth/login · /auth/mfa/verify · /auth/refresh · /auth/logout · /auth/verify-email · /auth/password-reset(/confirm) · /auth/me · /auth/totp/* · /auth/passkeys/* · /auth/sessions` and `auth/oauth/<provider>/start|callback`.

## Storage
`GET/POST /api/v1/<pid>/storage/<bucket>` (multipart or raw), `GET/DELETE …/<bucket>/<path>`, `POST …/<bucket>/sign` → signed URL. Public buckets also serve `/storage/public/<pid>/<bucket>/<path>`; signed delivery via `/storage/signed?token=…`.

## Functions
`POST/GET /api/v1/<pid>/functions/<slug>` invokes the function with `{ method, query, body, principal }`. Custom endpoints map `…/x/<path>` to functions.

## Realtime
`WebSocket /realtime/v1` — `{"op":"subscribe","channel":"project:<pid>:db:<table>","filter":{"col":"val"}}`, `broadcast`, `presence`, `ping`. Private channels require a valid project token.

## Admin API
Everything the dashboard uses lives under `/api/admin/*` (Bearer JWT from `/api/admin/login`). The CLI uses `/api/admin/cli/*` with the bootstrap token in `storage/system/cli-token`.
