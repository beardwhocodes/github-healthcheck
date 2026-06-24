# Plan 010: Add the missing D1 indexes for the admin audit/reports/inbox filters

> **Executor instructions**: Follow step by step; verify each step. Honor "STOP
> conditions". Update plan 010's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2abd6f3..HEAD -- migrations src/admin/audit.ts src/reports/store.ts src/messages/store.ts`
> If these changed, re-confirm the query shapes below; on mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (additive, idempotent indexes; no data change)
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `2abd6f3`, 2026-06-24

## Why this matters

Three admin list queries filter/sort on columns with **no covering index**, so
they full-scan their tables (then sort) and degrade as those tables grow:
- `admin_audit` — the sign-ins/actions filter does `WHERE action = 'login'` /
  `WHERE action <> 'login'` + `ORDER BY created_at DESC`; `admin_audit` is the
  fastest-growing table (one row per sign-in + every admin action), and only
  `created_at`/`admin_login` are indexed.
- `reported_repos` — the admin Reports list does `WHERE status = ? ORDER BY
  updated_at DESC` (and an unfiltered `ORDER BY updated_at DESC`); only
  `status`/`suspect_repo` and the unique `(reporter_login, suspect_repo)` are
  indexed — nothing on `updated_at`.
- `messages` — the Inbox does `WHERE status = ? ORDER BY created_at DESC`;
  `status` and `created_at` are indexed separately but not as a composite.

Adding the indexes is a one-file, append-only migration. (Confidence: MED — these
are clear index gaps; absolute cost depends on row volume. Verify with `EXPLAIN
QUERY PLAN` if you want certainty, but the indexes are safe regardless.)

## Current state

- Queries (do not change them):
  - `src/admin/audit.ts:53-60` — `WHERE action = 'login'` / `action <> 'login'` +
    `ORDER BY created_at DESC LIMIT ?`.
  - `src/reports/store.ts:103-105` — `WHERE status = ? ORDER BY updated_at DESC` /
    `ORDER BY updated_at DESC`.
  - `src/messages/store.ts:69-71` — `WHERE status = ? ORDER BY created_at DESC` /
    `ORDER BY created_at DESC`.
- Existing indexes (`migrations/0001_baseline.sql`): `admin_audit` →
  `idx_audit_created (created_at)`, `idx_audit_admin (admin_login)`;
  `reported_repos` → `idx_reports_status (status)`, `idx_reports_suspect`,
  unique `(reporter_login, suspect_repo)`; `messages` → `idx_messages_status`,
  `idx_messages_login`, `idx_messages_created (created_at)`.
- Migration convention (CRITICAL): migrations are **append-only**, numbered, and
  applied once in filename order. NEVER edit `0001_baseline.sql`. The last file
  is `0002_rate_events.sql`; add `0003_*.sql`. Each `CREATE INDEX` uses `IF NOT
  EXISTS` (see the baseline). Local apply: `pnpm run db:init`. The integration
  suite applies all `migrations/*.sql` (so a broken file fails the suite).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Apply migrations locally | `pnpm run db:init` | applies 0003 with no error |
| Integration tests | `pnpm test:integration` | all pass (applies 0003) |
| Typecheck | `pnpm typecheck` | exit 0 (no TS change, sanity) |

## Scope

**In scope**: `migrations/0003_admin_indexes.sql` (create).
**Out of scope**: editing any existing migration; changing the queries; the
`scans`/`users` indexes (already adequate). Do NOT add an index "just in case" on
columns not shown above.

## Git workflow

- Branch: `advisor/010-add-d1-indexes`
- One commit: `DB: index admin_audit.action, reported_repos + messages sort columns`.

## Steps

### Step 1: Create `migrations/0003_admin_indexes.sql`

```sql
-- Cover the admin filter/sort queries that previously full-scanned.
-- admin_audit: WHERE action = 'login' / action <> 'login' ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_audit_action ON admin_audit (action, created_at);

-- reported_repos: WHERE status = ? ORDER BY updated_at DESC (the admin Reports list)
CREATE INDEX IF NOT EXISTS idx_reports_status_updated ON reported_repos (status, updated_at);

-- messages: WHERE status = ? ORDER BY created_at DESC (the admin Inbox)
CREATE INDEX IF NOT EXISTS idx_messages_status_created ON messages (status, created_at);
```

### Step 2: Apply + verify

**Verify**:
- `pnpm run db:init` → applies migrations including 0003 with no error.
- `pnpm test:integration` → all pass (the integration harness applies every
  migration; a syntax error in 0003 would fail it).
- (Optional certainty) In a local `wrangler d1 execute` session, run
  `EXPLAIN QUERY PLAN SELECT * FROM admin_audit WHERE action = 'login' ORDER BY
  created_at DESC LIMIT 100;` and confirm it now uses `idx_audit_action` rather
  than a full SCAN.

## Test plan

- No new test code. The integration suite applying the new migration cleanly is
  the gate. Optionally add an assertion in an existing/new `*.itest.ts` that
  `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_audit_action'`
  returns a row.

## Done criteria

- [ ] `migrations/0003_admin_indexes.sql` exists with the three `CREATE INDEX IF NOT EXISTS`
- [ ] No existing migration file was modified (`git status` shows only the new file)
- [ ] `pnpm run db:init` applies without error
- [ ] `pnpm test:integration` exits 0
- [ ] `plans/README.md` row for 010 updated

## STOP conditions

- You find yourself editing `0001_baseline.sql` or any existing migration — STOP;
  migrations are append-only.
- `pnpm test:integration` fails after adding 0003 — the SQL is malformed; fix the
  migration (don't disable the test).

## Maintenance notes

- The composite `(status, updated_at)` / `(status, created_at)` indexes serve the
  status-filtered admin views; the unfiltered `ORDER BY updated_at/created_at`
  lists rely on the existing single-column indexes (or a small scan at LIMIT).
- If a new admin filter/sort column appears, index it in a new migration, not by
  editing 0003.
