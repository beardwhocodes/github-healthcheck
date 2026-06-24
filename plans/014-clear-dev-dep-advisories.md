# Plan 014: Clear the dev-dependency security advisories (or document deferral)

> **Executor instructions**: This plan has a real chance of NOT being worth
> completing — read "Why this matters" and the STOP conditions before touching
> anything. Follow step by step; if the upgrade destabilizes the test suites,
> REVERT and record the deferral. Update plan 014's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2abd6f3..HEAD -- package.json pnpm-lock.yaml`
> If these changed, re-run `pnpm audit` to get the current advisory set before
> proceeding.

## Status

- **Priority**: P3
- **Effort**: S (if the bump is clean) / M (if the test API moved)
- **Risk**: MED — the fix re-engages the exact `vitest`/`@cloudflare/vitest-pool-workers`
  version compatibility that previously broke CI (commits `e83b82c`, `a6ab28f`).
- **Depends on**: none
- **Category**: dependencies
- **Planned at**: commit `2abd6f3`, 2026-06-24

## Why this matters

`pnpm audit` reports 1 critical + 7 high advisories. **All are in
`devDependencies` / their transitive tree — none ship to the Cloudflare Worker
runtime.** The critical (`vitest < 3.2.6`, GHSA-5xrq-8626-4rwp) is an arbitrary
file read/execute *in the Vitest UI server* — and this project never runs the
Vitest UI (`vitest run`, no `--ui`), so its real exploitability here is ~nil. The
highs are transitive `wrangler`/`undici`/`devalue` advisories under
`@cloudflare/vitest-pool-workers`, exploitable only in a dev/CI context.

So the **value** is keeping the audit signal clean (a noisy baseline hides the
next real one), not closing a live hole. The **cost** is that clearing them means
bumping `vitest` 2→3 and `@cloudflare/vitest-pool-workers` to a vitest-3-compatible
release — and `vitest-pool-workers` is pre-1.0 with a moving test API; a
mismatch here is what broke this repo's CI before. **Get maintainer sign-off
that this is worth doing now**; otherwise the correct outcome is a documented
deferral.

## Current state

- `package.json`: `vitest ^2.1.8`, `@cloudflare/vitest-pool-workers ^0.6.16`
  (deliberately pinned to the vitest-2 line — see `plans/README.md` rejected/
  history and commit `e83b82c`). `wrangler ^4.103.0` (top-level, fine); the
  vulnerable wrangler is transitive under the test pool.
- Verification suites that MUST stay green: `pnpm test` (unit) and
  `pnpm test:integration` (Workers pool + D1, via `vitest.workers.config.ts`).
- The integration suite depends on `@cloudflare/vitest-pool-workers` internals
  (`cloudflare:test` imports `env`, `SELF`, `import.meta.glob` of migrations) —
  these are the surfaces most likely to shift across a major pool bump.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Audit | `pnpm audit` | the advisory list (before/after) |
| Why a dep resolves | `pnpm why wrangler` / `pnpm why vitest` | resolution tree |
| Unit tests | `pnpm test` | all pass |
| Integration tests | `pnpm test:integration` | all pass |
| Typecheck | `pnpm typecheck` | exit 0 |

## Scope

**In scope**: `package.json` (devDependency versions), `pnpm-lock.yaml`, and —
only if the pool's test API moved — the integration test files under
`tests/integration/` adapted to the new API.
**Out of scope**: production dependencies (`hono`, `react`, `wrangler`
top-level); changing what the tests assert; the Worker source.

## Git workflow

- Branch: `advisor/014-clear-dev-dep-advisories`
- One commit if clean; if the test API moved, a second commit for the test
  adaptations. Message e.g. `Deps: bump vitest + vitest-pool-workers to clear dev advisories`.

## Steps

### Step 1: Get sign-off / record the decision

Confirm with the operator that clearing dev-only advisories is wanted now given
the MED risk. If not, **skip to Step 4** (document deferral) — that is a valid
completion of this plan.

### Step 2: Coordinated bump

Bump together (the two must be compatible):
- `vitest` → `^3.2.6` (or latest 3.x)
- `@cloudflare/vitest-pool-workers` → the current release that targets vitest 3
  (check its peer range; e.g. the 0.8.x+ line). Use `pnpm why @cloudflare/vitest-pool-workers`
  / its README to find the matching pair.

Run `pnpm install`, then `pnpm dedup` to collapse the duplicate transitive
wrangler.

**Verify**: `pnpm install` succeeds; `pnpm why wrangler` shows the transitive
copy gone or patched.

### Step 3: Validate the suites (the gate)

**Verify ALL of these** — this is where the previous breakage happened:
- `pnpm test` → all pass.
- `pnpm test:integration` → all pass (this is the fragile one; if
  `cloudflare:test` imports or the pool config moved, adapt
  `vitest.workers.config.ts` / the `*.itest.ts` setup minimally and re-run).
- `pnpm typecheck` → exit 0.
- `pnpm audit` → the critical + 7 highs are gone (or reduced to dev noise-floor
  only).

If `pnpm test:integration` cannot be made green within a reasonable effort,
execute Step 4 (revert + defer) — do NOT ship a broken integration suite.

### Step 4: If deferring — revert cleanly and document

- `git checkout -- package.json pnpm-lock.yaml` (and any test edits); `pnpm install`.
- In `plans/README.md`, set plan 014's status to `BLOCKED — dev-only advisories;
  vitest 3 / pool-workers bump destabilizes test:integration, deferred` (or
  `REJECTED` if the operator decides it's not worth it).

## Test plan

- No new tests. The existing `pnpm test` + `pnpm test:integration` are the gate;
  they must stay green after the bump.

## Done criteria (one of the two)

**Completed**:
- [ ] `pnpm audit` no longer reports the critical + the 7 highs (dev noise-floor only)
- [ ] `pnpm test`, `pnpm test:integration`, `pnpm typecheck` all pass
- [ ] `plans/README.md` row for 014 = DONE

**OR Deferred** (equally valid):
- [ ] `package.json`/`pnpm-lock.yaml` reverted to the working pinned versions
- [ ] `pnpm test:integration` still green
- [ ] `plans/README.md` row for 014 = BLOCKED/REJECTED with the one-line reason

## STOP conditions

- `pnpm test:integration` fails after the bump and a short adaptation doesn't fix
  it — STOP, revert (Step 4), and defer. Dev-only advisories do NOT justify a
  broken integration suite.
- The bump pulls a `@cloudflare/vitest-pool-workers` major that changes how the
  worker runtime is configured beyond a trivial edit — STOP and report; that's a
  larger migration than this plan.

## Maintenance notes

- The real-world exposure is dev/CI machines only; there is no production impact.
  Treat the priority accordingly.
- Once on vitest 3, future patch bumps should be routine; the risk is specifically
  the 2→3 major paired with the pre-1.0 pool.
