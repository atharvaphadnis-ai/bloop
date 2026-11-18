# Authentication

Per-project end users (dashboard admins are separate — first-run setup creates the owner; support accounts: owner/admin/developer/viewer).

## Passwords & sessions
- scrypt (N=16384, r=8) hashing; plaintext never stored or logged.
- JWT access tokens (HS256, 15 min, HKDF-derived per-project key) + rotating refresh tokens (30 d) stored hashed; sessions revocable individually or all-at-once; brute-force lockout with exponential backoff.
- Email verification and password reset via tokens (1 h); without SMTP the token is returned in the response and clearly labeled "development mode".

## MFA & passkeys
- TOTP (RFC 6238): enroll → scan otpauth URL → confirm code → login requires the code.
- WebAuthn passkeys: registration + assertion verification implemented on `node:crypto` (CBOR decode, COSE→P-256 key import, ES256 signature check, sign-count cloning detection). ES256 credentials (the platform-authenticator default) are supported; other algorithms are reported unsupported.

## OAuth
Configure Google, GitHub or Discord per project (client secret encrypted with AES-256-GCM, masked in every response). Flow: `GET …/auth/oauth/<provider>/start` → provider → callback exchanges the code and links/creates the account. State is single-use (CSRF-safe).

## Row-level security
Policies per table/command with expressions like `user_id == auth.uid()`, `public == true or auth.jwt.claim.tenant == owner_id`, `auth.role() != 'anon'`, `in`, `contains`, `and/or/not`. Anon/authenticated principals get default-DENY without policies; service keys and dashboard admins bypass. Expressions compile to both a JS evaluator (row filtering) and parameterized SQL (never string-concatenated).

## SMTP & templates
Per-project SMTP (implicit TLS or STARTTLS, AUTH PLAIN/LOGIN), editable HTML templates for verification/reset/invitation with `{{app}} {{token}} {{link}}` variables, delivery log, test send.
