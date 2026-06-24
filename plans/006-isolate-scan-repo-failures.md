# Plan 006: One malformed repo no longer fails an entire account scan

> **Executor instructions**: Follow step by step; verify each step. Honor "STOP
> conditions". Update plan 006's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2abd6f3..HEAD -- src/github/snapshot.ts src/routes/scan.ts`
> If either changed, compare excerpts to live code; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 011 (recommended — its data-layer tests deepen coverage; not required)
- **Category**: bug
- **Planned at**: commit `2abd6f3`, 2026-06-24

## Why this matters

The account self-audit (`GET /report`) and "scan any account" (`GET /scan`) map
every repo through `buildRepoSnapshot` inside `mapWithConcurrency`, which has **no
per-item error isolation** — if any one snapshot rejects, `Promise.all` rejects
and the whole scan returns a generic 500. The clone-detection path deliberately
wraps each snapshot in `try/catch` and returns `null` for a bad repo (graceful
degradation); the scan path does not. `buildRepoSnapshot` is internally defensive
(every GitHub call is `.catch`ed), so the practical risk is low — but the
asymmetry is a real robustness gap, and a single odd repo shouldn't fail a user's
whole report. This also adds tests for the hand-rolled `mapWithConcurrency` pool,
which is currently untested.

## Current state

- `src/github/snapshot.ts`:
  - `mapWithConcurrency(items, concurrency, fn)` (lines 9–28) — `results[index] =
    await fn(items[index]!, index)` with **no** try/catch; one rejection rejects
    the whole `Promise.all`.
  - `buildRepoSnapshot(client, raw, opts)` (lines 105–144) — internally tolerant
    (each `client.*` call `.catch`ed), returns a `RepoSnapshot`.
- `src/routes/scan.ts` — two unguarded call sites:
  - `GET /report` (lines 70–72): `mapWithConcurrency(selected, 4, (raw) =>
    buildRepoSnapshot(client, raw))` then `evaluateAccount({ account, repos:
    snapshots, now })`.
  - `GET /scan` account branch (line 105): same shape.
- Compare the **intended** pattern in `src/github/clone-detection.ts:48-54`:
  ```ts
  const matches = await mapWithConcurrency(candidates, 3, async (raw) => {
    let snapshot: RepoSnapshot;
    try { snapshot = await buildRepoSnapshot(client, raw, { includeTree: true }); }
    catch { return null; }
    ...
  });
  ```
- Convention: unit tests in `tests/*.spec.ts` (node env, `pnpm test`). Functions
  take `client` as a parameter, so tests use a hand-rolled fake — no mock library.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass, incl. new file |
| Build dry-run | `pnpm exec wrangler deploy --dry-run` | exit 0 |

## Scope

**In scope**: `src/github/snapshot.ts`, `src/routes/scan.ts`,
`tests/snapshot.spec.ts` (create).
**Out of scope**: `src/github/clone-detection.ts` (already isolates — leave it),
the response shape of `/report` and `/scan` (clients depend on it — `scanned`
must remain the count of successfully-snapshotted repos).

## Git workflow

- Branch: `advisor/006-isolate-scan-repo-failures`
- One commit: `Scan: skip a repo that fails to snapshot instead of failing the run`.

## Steps

### Step 1: Add a tolerant snapshot wrapper in `snapshot.ts`

Add an exported helper next to `buildRepoSnapshot`:

```ts
// Like buildRepoSnapshot, but a thrown error (malformed repo object, etc.)
// degrades to null instead of aborting the whole pooled scan. Mirrors the
// per-candidate isolation in clone-detection.ts.
export async function buildRepoSnapshotSafe(
  client: GitHubClient,
  raw: Record<string, unknown>,
  opts: BuildRepoOptions = {},
): Promise<RepoSnapshot | null> {
  try {
    return await buildRepoSnapshot(client, raw, opts);
  } catch {
    return null;
  }
}
```

### Step 2: Use it at the two scan call sites and filter nulls

In `src/routes/scan.ts`, change both `mapWithConcurrency(... buildRepoSnapshot
...)` calls to `buildRepoSnapshotSafe`, then drop the nulls before
`evaluateAccount`:

```ts
const snapshotsRaw = await mapWithConcurrency(selected, 4, (raw) =>
  buildRepoSnapshotSafe(client, raw),
);
const snapshots = snapshotsRaw.filter((s): s is RepoSnapshot => s !== null);
```

`scanned: snapshots.length` then correctly reports repos actually scanned. Import
`buildRepoSnapshotSafe` (and `RepoSnapshot` type if not already) accordingly.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Test `mapWithConcurrency` + the wrapper

Create `tests/snapshot.spec.ts` covering the pool primitive and the new wrapper:
- `mapWithConcurrency` preserves input order in the results array.
- it respects the concurrency cap (track concurrent in-flight count; assert max
  observed ≤ cap — e.g. resolve via deferred promises).
- it **propagates** a rejection when the callback throws (documents why the wrap
  is needed): `await expect(mapWithConcurrency([1,2,3], 2, async n => { if (n===2)
  throw new Error('x'); return n })).rejects.toThrow()`.
- `buildRepoSnapshotSafe` returns `null` when `buildRepoSnapshot` would throw —
  construct a minimal fake `GitHubClient` (cast `as unknown as GitHubClient`)
  whose methods reject, and a `raw` object; assert the result is `null`, and that
  a well-formed fake yields a non-null snapshot.

**Verify**: `pnpm test -- snapshot` → pass.

## Test plan

- New `tests/snapshot.spec.ts` (4 cases above). Pattern: `tests/scan-stats.spec.ts`.
- Verification: `pnpm test` all pass; `pnpm typecheck` exit 0.

## Done criteria

- [ ] `pnpm typecheck` exits 0
- [ ] `grep -n "buildRepoSnapshotSafe" src/routes/scan.ts` → 2 call sites
- [ ] `grep -n "buildRepoSnapshot(client, raw))" src/routes/scan.ts` → no unguarded calls remain
- [ ] `pnpm test` exits 0 with `tests/snapshot.spec.ts` passing
- [ ] Response shape unchanged (`report`, `scanned`, `totalRepos` keys intact)
- [ ] `git status` shows only the three in-scope files
- [ ] `plans/README.md` row for 006 updated

## STOP conditions

- The fix seems to require changing `mapWithConcurrency`'s signature/contract
  (it is shared with clone-detection) — don't; isolate at the call site instead.
- `evaluateAccount` rejects `null` repos and you're tempted to pass them through
  — you must filter nulls before calling it.

## Maintenance notes

- If a future change makes `buildRepoSnapshot` itself swallow all throws, the
  wrapper becomes belt-and-suspenders — keep it anyway for the explicit contract.
- A reviewer should confirm `scanned` still reflects successful snapshots, not
  the pre-filter count.
