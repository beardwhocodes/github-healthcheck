# Plan 012: Integration tests for the session lifecycle and OAuth state checks

> **Executor instructions**: Follow step by step; verify each step. Honor "STOP
> conditions". Update plan 012's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2abd6f3..HEAD -- src/auth/session.ts src/auth/github-oauth.ts`
> If either changed, compare excerpts to live code; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (adds tests only)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `2abd6f3`, 2026-06-24

## Why this matters

The login path and session lifecycle have no regression guard: the OAuth state
check (the CSRF defense — `state !== returnedState` rejection), the bad/missing
state branches, expired-session deletion, and `sweepExpiredSessions` are
untested (the admin integration suite hand-seeds session rows but never exercises
these branches). A break here is a full auth outage or a CSRF-check bypass. This
plan covers the cleanly-testable, security-critical pieces with the existing
Workers/D1 harness; the OAuth happy path (which needs outbound-fetch stubbing) is
included only if the runtime supports it.

## Current state

- `src/auth/session.ts`:
  - `getSession` (54–84): looks up by `sha256Hex(cookie)`; if `expires_at <
    now`, **deletes the row and returns null** (64–67); decrypt failure → null.
  - `sweepExpiredSessions(env, now)` (89–91): `DELETE FROM sessions WHERE
    expires_at < ?`.
- `src/auth/github-oauth.ts` — `GET /auth/callback` (44–140):
  - missing `code`/`state`/state-cookie → `redirect('/?error=oauth_missing_params')`.
  - `verify(signedState)` fails → `redirect('/?error=oauth_bad_state')`.
  - `expectedState !== returnedState` → `redirect('/?error=oauth_state_mismatch')`.
  - happy path: exchanges code (POST github.com), fetches `api.github.com/user`,
    upserts user + audit, creates session, `redirect('/?signed_in=1')`.
  - The state cookie is `rs_oauth_state`, value = `sign(\`${state}:${priv}\`,
    SESSION_SECRET)` (signed via `src/auth/crypto.ts`).
- Test harness (`tests/integration/admin.itest.ts`, copy these helpers verbatim):
  `applyMigrations()`, `seedSession(login)` (inserts a session row, returns the
  raw cookie id), `as(cookie)` → `{ headers: { Cookie: \`rs_session=...\` } }`,
  `url(path)` → `https://test.local${path}`, and `SELF.fetch`. `env`/`DB`/
  `SESSION_SECRET` come from `cloudflare:test`. Run with `pnpm test:integration`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm typecheck` | exit 0 |
| Integration tests | `pnpm test:integration` | all pass, incl. new file |

## Scope

**In scope**: `tests/integration/auth.itest.ts` (create).
**Out of scope**: any `src/` file (tests only — a real bug found → STOP and
report); the unit-level crypto tests (plan 002 owns those).

## Git workflow

- Branch: `advisor/012-test-auth-lifecycle`
- One commit: `Test: session expiry/sweep + OAuth state-check branches`.

## Steps

### Step 1: Session lifecycle (no fetch stubbing needed)

In `tests/integration/auth.itest.ts` (reuse the helpers from `admin.itest.ts`):
- **Expired session → 401 + row deleted**: insert a session row with
  `expires_at` in the **past** (adapt `seedSession` to take an expiry), then
  `SELF.fetch(url('/api/me'), as(cookie))` → **401**; then assert the row is
  gone from `sessions` (getSession deletes expired rows).
- **Valid session → 200**: a future-expiry session reaches `/api/me` with 200
  (sanity; mirrors `admin.itest.ts`).
- **`sweepExpiredSessions`**: seed one expired + one valid session row; call
  `sweepExpiredSessions(appEnv, Date.now())`; assert only the valid row remains
  (`SELECT COUNT(*)`).

### Step 2: OAuth state-rejection branches (no external fetch)

These branches redirect **before** any GitHub call, so no stubbing is needed.
Use `SELF.fetch(url('/auth/callback?...'), { redirect: 'manual' })` and assert
the `Location` header:
- no `code`/`state` → `Location` contains `error=oauth_missing_params`.
- a `state` cookie that isn't a valid signature → `error=oauth_bad_state`. (Set
  the cookie via `headers: { Cookie: 'rs_oauth_state=garbage' }` plus a `state`
  and `code` query param.)
- a **validly signed** state cookie whose embedded state ≠ the `state` query
  param → `error=oauth_state_mismatch`. (Build the cookie with the real `sign`
  from `../../src/auth/crypto.js`: `await sign('abc:0', SESSION_SECRET)`, then
  pass `?state=different&code=x`.)

### Step 3 (optional): OAuth happy path — only if outbound fetch can be stubbed

The happy path calls `fetch('https://github.com/login/oauth/access_token')` and
`fetch('https://api.github.com/user')`. Try `@cloudflare/vitest-pool-workers`'s
`fetchMock` from `cloudflare:test` to intercept both and return a canned token +
user. If `fetchMock` is available, assert: a valid signed state matching the
query → response sets an `rs_session` cookie and `Location` contains
`signed_in=1`, and a `sessions` row now exists. **If `fetchMock` is not exported
by the installed version (0.6.x), SKIP this step** (leave a `it.skip` with a
comment) — do not block the plan on it.

**Verify**: `pnpm test:integration` → all pass (Step 3 skipped is acceptable).

## Test plan

- `tests/integration/auth.itest.ts` (Steps 1–2 required, Step 3 optional).
  Pattern: `tests/integration/admin.itest.ts`.
- Verification: `pnpm test:integration` all pass.

## Done criteria

- [ ] `pnpm test:integration` exits 0 with `tests/integration/auth.itest.ts` passing
- [ ] Session: expired → 401 + row deleted; `sweepExpiredSessions` removes only expired
- [ ] OAuth: all three state-rejection branches assert the right `error=` redirect
- [ ] `pnpm typecheck` exits 0
- [ ] `git status` shows only the new test file
- [ ] `plans/README.md` row for 012 updated

## STOP conditions

- The expired-session test does NOT return 401 (getSession isn't deleting/rejecting
  expired rows) — real bug; STOP and report.
- The state-mismatch branch does NOT redirect with `oauth_state_mismatch` — real
  CSRF-relevant bug; STOP and report.
- `redirect: 'manual'` isn't honored by `SELF.fetch` in this harness — inspect
  `res.status` (302) and read `res.headers.get('location')` instead; if neither
  works, STOP.

## Maintenance notes

- Deferred (not in this plan): an end-to-end `runImpersonationScan` cron test
  asserting the scan→diff→**email**→record flow. It needs an `EMAIL` binding
  test double (the cron calls `env.EMAIL.send`), which the current harness
  doesn't provide. The cron's core "only-alert-new + retry-on-failed-send"
  invariant is already guarded at the store level by plan 001's
  `tests/integration/alerts.itest.ts`. Add the full cron E2E when an EMAIL
  double is wired.
- A reviewer should confirm no real token/secret value is hardcoded (dummy
  strings only).
