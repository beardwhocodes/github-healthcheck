# Plan 007: The daily cron scans subscribers with bounded concurrency

> **Executor instructions**: Follow step by step; verify each step. Honor "STOP
> conditions". Update plan 007's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2abd6f3..HEAD -- src/alerts/cron.ts src/github/snapshot.ts`
> If either changed, compare excerpts to live code; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (GitHub search shares one secondary-rate-limit pool; over-parallelizing trips 429s)
- **Depends on**: 012 (recommended — land the cron lifecycle tests first)
- **Category**: perf
- **Planned at**: commit `2abd6f3`, 2026-06-24

## Why this matters

`runImpersonationScan` (the daily cron) processes subscribers in a **strictly
sequential** `for` loop: per subscriber it decrypts a token, lists watched repos,
runs clone detection (multiple GitHub *search* + snapshot calls), diffs the
baseline, optionally emails, and records. Wall-clock grows linearly with
subscriber count × repos-each; at a few hundred subscribers the single daily run
risks brushing the Worker CPU/subrequest budget. This is the one unbounded
growth path in the system (on-demand routes are already capped and pooled). Bound
it with the existing `mapWithConcurrency` helper at a **low** concurrency so it
parallelizes without tripping GitHub's shared search rate limit.

## Current state

- `src/alerts/cron.ts` (lines 17–77):
  ```ts
  export async function runImpersonationScan(env: Env, now: number): Promise<void> {
    let subscriptions;
    try { subscriptions = await listActiveSubscriptions(env); }
    catch (err) { console.log(`[cron] could not load subscriptions: ${String(err)}`); return; }

    for (const sub of subscriptions) {
      try {
        // decrypt token, getWatchedRepos, findClonesForRepos, diff, send, recordClones, setLastRun
      } catch (err) {
        console.log(`[cron] scan failed for ${sub.login}: ${String(err)}`);
      }
    }
  }
  ```
  The per-subscriber body is already wrapped in its own `try/catch` so one
  subscriber's failure doesn't abort the batch — **preserve that**.
- `src/github/snapshot.ts:9` exports `mapWithConcurrency(items, concurrency, fn)`
  — a bounded worker pool already used by the on-demand scan/clone paths.
- Inside the loop, `findClonesForRepos` itself already pools internally
  (`mapWithConcurrency(sources, 2, ...)` and `(candidates, 3, ...)`), so the
  outer subscriber concurrency multiplies with those — keep the outer N small.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm typecheck` | exit 0 |
| Integration tests | `pnpm test:integration` | all pass |
| Unit tests | `pnpm test` | all pass |
| Build dry-run | `pnpm exec wrangler deploy --dry-run` | exit 0 |

## Scope

**In scope**: `src/alerts/cron.ts`.
**Out of scope**: `findClonesForRepos` internal concurrency, the email sending,
`mapWithConcurrency` itself. Do NOT remove the per-subscriber `try/catch`.

## Git workflow

- Branch: `advisor/007-bound-cron-concurrency`
- One commit: `Alerts cron: scan subscribers with bounded concurrency`.

## Steps

### Step 1: Replace the sequential loop with a bounded pool

Import `mapWithConcurrency` from `../github/snapshot.js`. Convert the
subscriber `for` loop into a pooled map, keeping the per-subscriber `try/catch`
exactly as-is inside the callback:

```ts
const CRON_CONCURRENCY = 3; // small: GitHub search shares one secondary-limit pool
await mapWithConcurrency(subscriptions, CRON_CONCURRENCY, async (sub) => {
  try {
    // ... the existing per-subscriber body, unchanged ...
  } catch (err) {
    console.log(`[cron] scan failed for ${sub.login}: ${String(err)}`);
  }
});
```

Keep the outer `listActiveSubscriptions` `try/catch` and early return. The
callback returns `void`; that's fine for `mapWithConcurrency`.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Confirm nothing else changed

The diff should be only: the loop → `mapWithConcurrency` conversion + the
constant. No change to the decrypt/diff/send/record logic.

**Verify**: `pnpm test:integration` → all pass (the `listActiveSubscriptions`
suspension test still holds); `pnpm exec wrangler deploy --dry-run` → exit 0.

## Test plan

- No new unit test in this plan (the cron's collaborators construct a real
  `GitHubClient`/`EMAIL` internally; end-to-end cron coverage is plan 012's job —
  land 012 first per Depends-on).
- Regression safety here = `pnpm test:integration` green + a careful review that
  the per-subscriber `try/catch` and the diff/record logic are byte-identical
  aside from the pooling wrapper.

## Done criteria

- [ ] `pnpm typecheck` exits 0
- [ ] `grep -n "mapWithConcurrency(subscriptions" src/alerts/cron.ts` matches with a small N (≤4)
- [ ] `grep -n "for (const sub of subscriptions)" src/alerts/cron.ts` returns no match
- [ ] The per-subscriber `try { ... } catch` is still present inside the callback
- [ ] `pnpm test` && `pnpm test:integration` exit 0; `wrangler deploy --dry-run` exit 0
- [ ] `git status` shows only `src/alerts/cron.ts`
- [ ] `plans/README.md` row for 007 updated

## STOP conditions

- You cannot preserve the per-subscriber `try/catch` while pooling — STOP (one
  subscriber's error must not abort others).
- You're tempted to raise concurrency above ~4 — don't; GitHub search secondary
  rate limits are shared process-wide and `findClonesForRepos` already
  parallelizes internally.
- Plan 012 (cron lifecycle tests) has not landed and the operator wants test
  coverage before this refactor — pause and surface that.

## Maintenance notes

- If subscriber count grows large enough that even pooled scanning brushes the
  Worker limits, the next step is sharding the cron (process a slice per run via
  a cursor) rather than raising concurrency.
- Watch for 429s from GitHub search in the cron logs after this lands; lower
  `CRON_CONCURRENCY` if they appear.
