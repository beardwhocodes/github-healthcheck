# Plan 017 [SPIKE]: Design "watch any repo" for clone alerts (not just your own)

> **Executor instructions**: DESIGN/INVESTIGATION spike. Deliverable is a design
> doc + (optionally) a thin prototype of the input-validation path. Do NOT ship
> the production feature. Update plan 017's row in `plans/README.md`.

## Status

- **Priority**: P3
- **Effort**: M (design/spike; coarse)
- **Risk**: MED (unbounded watch lists multiply the daily GitHub-search cost; needs per-user caps)
- **Depends on**: 007 (recommended — bounded cron concurrency lands first, since this grows the cron's work)
- **Category**: direction
- **Planned at**: commit `2abd6f3`, 2026-06-24

## Why this matters (product value)

Alerts watch only the subscriber's **own** non-fork/non-private repos
(`src/routes/alerts.ts:67-78`), yet the on-demand `/api/scan` already scans **any**
repo or account (`parseTarget`). The watch infrastructure is already generic:
`watched_repos` is a `(login, full_name)` string set and the cron loop
(`src/alerts/cron.ts`) is ownership-agnostic — it just reads `getWatchedRepos`.
So maintainers of popular projects, security researchers, and orgs who want
alerts on namespaces they don't own are blocked only by the subscribe route's
self-restriction. This is a clear surface asymmetry ("scan any" exists, "watch
any" doesn't) the architecture already supports.

## Current state (grounding)

- `src/routes/alerts.ts` (POST `/alerts`, 66–78): derives watched repos from the
  caller's own repos (`client.listRepos({ self: true })`, filter
  `!fork && !private`, sort by stars, slice 15) → `setWatchedRepos(login, names)`.
- `src/alerts/store.ts` — `setWatchedRepos(login, fullNames[])` /
  `getWatchedRepos(login)` are generic over full-name strings (no ownership
  check).
- `src/routes/scan.ts` — `parseTarget` + `isValidName` already validate/normalize
  user-supplied `owner/repo` targets safely.
- `src/alerts/cron.ts` — iterates `getWatchedRepos(sub.login)` and runs
  `findClonesForRepos` over them; already generic. (Plan 007 bounds its
  concurrency.)
- `web/src/components/AlertsPanel.tsx` — the subscribe/alerts UI.

## Deliverable

A design doc at `docs/proposals/017-watch-any-repo.md` (create `docs/proposals/`
if needed) covering the decisions below + this plan's row updated.

## Investigate & decide (write into the doc)

1. **Input path**: let the subscribe/alerts flow accept user-supplied watch
   targets (reuse `parseTarget`/`isValidName` for validation/normalization to
   `owner/repo`). Repo-only, or also a whole `owner` namespace? (Namespace
   watching multiplies search cost — decide.)
2. **Cap**: the current implicit cap is the `15` slice of own repos. Define an
   explicit per-user max watched count and enforce it server-side in
   `setWatchedRepos`'s caller. What number balances value vs the shared GitHub
   search budget?
3. **Cost model**: cron cost ≈ Σ(subscribers × watched × candidates). With
   arbitrary targets this grows faster; relate it to plan 007's concurrency and
   whether the cron needs sharding (a cursor over subscribers per run).
4. **UX**: how a user adds/removes a watched repo in `AlertsPanel.tsx` (the
   current flow auto-derives the list; this needs an explicit add/remove list).
5. **Baseline semantics**: the subscribe flow seeds a baseline of current clones
   per watched repo so only NEW ones alert — confirm that still works when the
   user adds a target later (seed that target's baseline on add).
6. **Open questions** for the maintainer.

## Optional thin prototype (de-risk)

Prototype the **validation + cap** only, as a pure function (no route change):
`normalizeWatchTargets(inputs: string[], max: number): { ok: string[]; rejected:
string[] }` in e.g. `src/alerts/watch-targets.ts`, reusing `parseTarget`/
`isValidName`, with a unit test (`tests/watch-targets.spec.ts`). This proves the
safe-input path without touching the subscribe route, cron, or UI.

## Done criteria

- [ ] `docs/proposals/017-watch-any-repo.md` answers items 1–6 with a recommendation
      (especially the cap and the cost/sharding relationship to plan 007)
- [ ] If prototyped: `normalizeWatchTargets` + unit test exist and pass (`pnpm test`),
      with NO route/cron/UI change
- [ ] `plans/README.md` row for 017 updated

## STOP conditions

- You're about to change the live subscribe route / cron / `AlertsPanel.tsx` to
  ship the feature — STOP; this spike ends at an approved design.
- The cost model shows arbitrary watching is infeasible without cron sharding —
  document that as the gating decision; don't ship an unbounded watch list.

## Maintenance notes

- A real build must land the per-user cap and (likely) cron sharding together,
  and seed a per-target baseline on add so the first scan after adding doesn't
  alert on pre-existing clones.
- Reuse `parseTarget`/`isValidName` — do not write a second target parser.
