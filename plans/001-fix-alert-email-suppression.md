# Plan 001: A failed alert email no longer permanently suppresses that clone alert

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row for plan 001 in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2abd6f3..HEAD -- src/alerts/store.ts src/alerts/cron.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts below against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `2abd6f3`, 2026-06-24

## Why this matters

The product's core promise is "we email you when a NEW malicious clone of your
repo appears." The daily cron records every freshly-detected clone into
`known_clones` so it only alerts once — but it records them **whether or not the
email actually sent**, and the "have we seen this clone?" query **ignores the
`notified` flag entirely**. So a transient email failure (provider error, rate
limit, a bad address) on the night a clone first appears marks that clone as
"known" forever, and the user is *never* told about it. The `notified` column is
written but never read. This silently defeats the feature for exactly the cases
that matter most.

## Current state

- `src/alerts/store.ts` — the alert data layer. Two functions are wrong:
  - `getKnownSuspectRepos` (lines 172–179) returns the baseline set the cron
    diffs against, **ignoring `notified`**:
    ```ts
    export async function getKnownSuspectRepos(env: Env, login: string): Promise<Set<string>> {
      const { results } = await env.DB.prepare(
        `SELECT suspect_repo FROM known_clones WHERE login = ?`,
      )
        .bind(login)
        .all<{ suspect_repo: string }>();
      return new Set((results ?? []).map((r) => r.suspect_repo.toLowerCase()));
    }
    ```
  - `recordClones` (lines 181–201) uses `INSERT OR IGNORE`, so a later
    successful send for an already-recorded (unsent) clone can **never flip
    `notified` to 1** (the conflict is ignored):
    ```ts
    const stmts = clones.map((clone) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO known_clones (login, source_repo, suspect_repo, confidence, first_seen, notified)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(login, clone.sourceRepo, clone.suspectRepo, clone.confidence, clone.firstSeen, clone.notified ? 1 : 0),
    );
    await env.DB.batch(stmts);
    ```
- `src/alerts/cron.ts` (lines 46–72) already passes the correct `notified: sent`
  per run, and the baseline seed in `src/routes/alerts.ts:90` passes
  `notified: true`. **So the fix is entirely in `store.ts` — `cron.ts` does not
  change.** With the fix, an unsent clone stays out of the "known" set and is
  retried next run; a later successful send upgrades it to known.
- Schema fact (do not change it): `known_clones` has `PRIMARY KEY (login,
  suspect_repo)` (`migrations/0001_baseline.sql:62`) and `notified INTEGER NOT
  NULL DEFAULT 0` (line 61). The PK is what makes the `ON CONFLICT` upsert below
  work.
- Convention: store functions are plain async D1 query-builders; integration
  tests drive them against real miniflare D1 — see `tests/integration/admin.itest.ts`
  (the `applyMigrations()` helper + direct store calls). Match that file's style.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Integration tests | `pnpm test:integration` | all pass, incl. the new file |
| Unit tests | `pnpm test` | all pass (unchanged) |

## Scope

**In scope** (only files you may modify):
- `src/alerts/store.ts`
- `tests/integration/alerts.itest.ts` (create)

**Out of scope** (do NOT touch):
- `src/alerts/cron.ts` — already passes `notified: sent` correctly; the fix
  does not require changing it. Changing it risks re-introducing the bug.
- Any migration file — the schema already supports this; no migration needed.
- The `known_clones` PRIMARY KEY / columns.

## Git workflow

- Branch: `advisor/001-fix-alert-email-suppression`
- One commit. Message style matches the repo's imperative subject lines (e.g.
  `git log` shows "Audit log: record sign-ins, add a sign-ins/actions filter").
  Suggested: `Alerts: retry clone alerts whose email failed to send`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Only treat *notified* clones as already-seen

In `src/alerts/store.ts`, change `getKnownSuspectRepos`'s query to filter on the
flag:

```ts
`SELECT suspect_repo FROM known_clones WHERE login = ? AND notified = 1`
```

(Everything else in the function stays identical.)

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Make `recordClones` upgrade `notified` on a later successful send

In `src/alerts/store.ts`, replace the `INSERT OR IGNORE` statement in
`recordClones` with an upsert that flips `notified` to 1 when a later call sends
successfully, but never downgrades it:

```ts
const stmts = clones.map((clone) =>
  env.DB.prepare(
    `INSERT INTO known_clones (login, source_repo, suspect_repo, confidence, first_seen, notified)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(login, suspect_repo) DO UPDATE SET
       notified = CASE WHEN excluded.notified = 1 THEN 1 ELSE known_clones.notified END`,
  ).bind(login, clone.sourceRepo, clone.suspectRepo, clone.confidence, clone.firstSeen, clone.notified ? 1 : 0),
);
await env.DB.batch(stmts);
```

Keep the early `if (clones.length === 0) return;` guard and the `env.DB.batch`
call as they are.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Add a store-contract regression test

Create `tests/integration/alerts.itest.ts`, modeled on
`tests/integration/admin.itest.ts` (copy its `cloudflare:test` import, the
`applyMigrations()` helper verbatim, and the `beforeEach(applyMigrations)`
setup). Import `getKnownSuspectRepos` and `recordClones` from
`../../src/alerts/store.js`. Cover exactly these cases:

1. **Unsent clone is NOT suppressed**: `recordClones(env, 'alice', [{...,
   notified: false}])`, then `getKnownSuspectRepos(env, 'alice')` returns an
   **empty** set.
2. **Sent clone IS suppressed**: `recordClones(env, 'alice', [{..., notified:
   true}])`, then `getKnownSuspectRepos` contains the suspect (lowercased).
3. **A failed-then-successful send upgrades to known**: record the same
   `(login, suspect_repo)` first with `notified: false` then with `notified:
   true`; assert `getKnownSuspectRepos` now contains it (the regression: proves
   the alert fires the first time the email succeeds, not never).
4. **A later unsent run does NOT downgrade**: after case 3, record the same
   suspect again with `notified: false`; assert it is **still** in
   `getKnownSuspectRepos` (no flapping back to un-alerted).

Use `suspectRepo` values with mixed case (e.g. `'EvilOrg/Repo'`) to also cover
the `.toLowerCase()` normalization.

**Verify**: `pnpm test:integration` → all pass, including the 4 new assertions in
`tests/integration/alerts.itest.ts`.

## Test plan

- New file `tests/integration/alerts.itest.ts` (4 cases above), structural
  pattern = `tests/integration/admin.itest.ts`.
- This is the regression guard for the exact bug: case 1 fails on the old code
  (unsent clone WAS suppressed), passes on the new.
- Verification: `pnpm test:integration` → all pass; `pnpm test` still green.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test:integration` exits 0; `tests/integration/alerts.itest.ts` exists with the 4 cases and passes
- [ ] `pnpm test` exits 0 (unchanged)
- [ ] `grep -n "notified = 1" src/alerts/store.ts` matches (the filter is in place)
- [ ] `grep -n "INSERT OR IGNORE" src/alerts/store.ts` returns **no** match (replaced by the upsert)
- [ ] `git status` shows only `src/alerts/store.ts` and `tests/integration/alerts.itest.ts` modified/created
- [ ] `plans/README.md` status row for 001 updated

## STOP conditions

Stop and report (do not improvise) if:

- The "Current state" excerpts don't match the live `src/alerts/store.ts` (drift).
- `known_clones` does **not** have `PRIMARY KEY (login, suspect_repo)` in the
  live schema — the `ON CONFLICT(login, suspect_repo)` target depends on it.
- `pnpm test:integration` fails to start (miniflare/D1 harness issue) rather
  than failing an assertion — that's an environment problem, not this change.
- The fix appears to require editing `cron.ts` or a migration (it should not).

## Maintenance notes

- The `notified` column is now load-bearing (it gates the diff). If anyone adds
  a UI or export over `known_clones`, remember rows can be `notified = 0`
  (detected-but-not-yet-alerted).
- A permanently-failing recipient now causes a daily re-detect + re-send attempt
  (no suppression until a send succeeds). That is intended (keep trying) but if
  it becomes noisy, a future plan could cap retries via an attempt counter.
- Related deferred item (see `plans/README.md`): `cron.ts:79 dedupeBySuspect`
  keeps first-seen while `clone-detection.ts:96` keeps highest-confidence — not
  fixed here; revisit when consolidating the clone path.
