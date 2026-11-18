# SDK directory

Two kinds of SDKs live here:

1. **Generated per-project SDKs** — `generated/<projectId>/…` created by the
   SDK generator (dashboard → API Explorer → Generate, or
   `bloop sdk generate <projectId>`). Contains `bloop-js/`, `bloop-ts/`,
   `bloop-python/`, `bloop-go/`, `bloop-dart/` plus a README with a base URL
   and quick-start. A ZIP can be downloaded directly from the dashboard.

2. **Regeneration** — templates are embedded in
   `backend/infrastructure/sdk-generator.js`; editing them changes what future
   generations produce for JavaScript, TypeScript, Python, Go and Dart clients
   (auth, database queries, storage, functions, GraphQL and JS/TS realtime).
