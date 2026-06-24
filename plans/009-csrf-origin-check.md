# Plan 009: State-changing API requests require a same-origin Origin (CSRF defense-in-depth)

> **Executor instructions**: Follow step by step; verify each step. Honor "STOP
> conditions". Update plan 009's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2abd6f3..HEAD -- src/index.ts src/auth/session.ts`
> If either changed, compare excerpts to live code; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (the SPA is same-origin, so legitimate requests are unaffected)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `2abd6f3`, 2026-06-24

## Why this matters

Every state-changing API route (`POST /api/contact`, `POST/DELETE /api/alerts`,
all `POST /api/admin/*` suspend/role/report actions) is authorized **only** by the
session cookie, which is `SameSite=Lax` (`src/auth/session.ts:48`) with no CSRF
token or Origin check. `SameSite=Lax` blocks most cross-site cookie sending, so
this is largely mitigated — but for an admin panel that can change roles and
suspend accounts, defense-in-depth is thin: a same-site subdomain XSS or a future
`SameSite` regression would expose all mutations. Adding an Origin check on the
API mutation group is cheap, non-breaking for the same-origin SPA, and closes the
gap. Hono ships a `csrf()` middleware that does exactly this.

## Current state

- `src/index.ts` mounts the authenticated API group (lines ~46–60):
  ```ts
  const api = new Hono<{ Bindings: Env; Variables: Vars }>();
  api.use('*', requireAuth);
  api.route('/', scan);
  api.route('/', alerts);
  api.route('/', contact);
  api.route('/admin', admin);
  app.route('/api', api);
  ```
- `src/routes/middleware.ts` — `requireAuth`/`requireAdmin`/`requireNotSuspended`;
  no Origin/CSRF check exists anywhere (`grep -rn "Origin\|csrf\|Sec-Fetch" src/`
  → nothing).
- Dependency: `hono ^4.6.14` (provides `hono/csrf`). The SPA calls the API
  same-origin (served from the same Worker host), so `csrf()`'s same-origin check
  passes for legitimate traffic.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm typecheck` | exit 0 |
| Integration tests | `pnpm test:integration` | all pass, incl. new CSRF cases |
| Build dry-run | `pnpm exec wrangler deploy --dry-run` | exit 0 |

## Scope

**In scope**: `src/index.ts`, `tests/integration/csrf.itest.ts` (create).
**Out of scope**: the session cookie attributes (do NOT change `SameSite` — Lax
is required for the OAuth top-level redirect to carry the cookie); `/auth/*` and
`/email/*` routes (the OAuth state cookie + token links are their own CSRF
defense). GET routes (safe methods) must remain unaffected.

## Git workflow

- Branch: `advisor/009-csrf-origin-check`
- One commit: `Security: reject cross-origin state-changing API requests (CSRF)`.

## Steps

### Step 1: Mount Hono's `csrf()` on the API group

In `src/index.ts`, import and apply the CSRF middleware to the `/api` group
**before** `requireAuth`, so a cross-origin mutation is rejected before any work:

```ts
import { csrf } from 'hono/csrf';
// ...
const api = new Hono<{ Bindings: Env; Variables: Vars }>();
api.use('*', csrf());          // same-origin check on unsafe methods
api.use('*', requireAuth);
```

`csrf()` only guards unsafe methods (POST/PUT/PATCH/DELETE) by validating the
`Origin` header against the request host; GET stays open. (If a config is needed
because the API host differs from `APP_URL` in some environment, pass `csrf({
origin: (origin, c) => origin === new URL(c.env.APP_URL).origin })` — but the
default same-origin behavior is correct for this single-host setup.)

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Add integration tests

Create `tests/integration/csrf.itest.ts` (pattern: `tests/integration/admin.itest.ts`,
using `SELF.fetch`). Cover:
- A `POST /api/contact` with an `Origin` header of `https://evil.example` →
  status **403** (CSRF rejected, before auth).
- A `POST /api/contact` with **no/ same-origin** `Origin` and no session →
  status **401** (CSRF passed, then `requireAuth` rejects) — proves the guard
  doesn't block legitimate same-origin requests.
- A `GET /api/me` with a cross-origin `Origin` → not 403 (safe method unaffected;
  it returns 401 without a session, which is fine).

**Verify**: `pnpm test:integration` → all pass including the new file.

## Test plan

- `tests/integration/csrf.itest.ts` (3 cases above).
- Verification: `pnpm test:integration` all pass; `pnpm exec wrangler deploy
  --dry-run` exit 0.

## Done criteria

- [ ] `pnpm typecheck` exits 0
- [ ] `grep -n "csrf()" src/index.ts` matches, placed before `requireAuth` on the api group
- [ ] `pnpm test:integration` exits 0; cross-origin POST → 403, same-origin POST → 401, GET unaffected
- [ ] `pnpm exec wrangler deploy --dry-run` exits 0
- [ ] `git status` shows only `src/index.ts` and `tests/integration/csrf.itest.ts`
- [ ] `plans/README.md` row for 009 updated

## STOP conditions

- The same-origin SPA request path would be rejected by `csrf()` (e.g. the test
  for a same-origin POST returns 403, not 401) — the middleware is misconfigured;
  fix the origin predicate before marking done. Do NOT loosen it to allow all
  origins.
- `hono/csrf` does not exist in the installed Hono version — STOP and report
  (then a hand-rolled `Sec-Fetch-Site`/`Origin` middleware is the fallback).

## Maintenance notes

- This is defense-in-depth layered on `SameSite=Lax`; keep both.
- If a non-browser API client (e.g. plan 015's public scan API with a token) is
  added later, it won't send a same-origin `Origin` — exempt token-authenticated
  requests from the CSRF check at that point (CSRF only applies to
  cookie/ambient auth).
- `POST /auth/logout` is intentionally NOT covered (CSRF-logout is a nuisance,
  not a breach); revisit only if desired.
