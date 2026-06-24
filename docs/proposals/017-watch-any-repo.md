# Proposal 017 — Watch Any Repo for Clone Alerts

**Status:** Spike / Design  
**Author:** advisor spike (2026-06-24)  
**Related files:** `src/routes/alerts.ts`, `src/alerts/store.ts`,
`src/alerts/cron.ts`, `src/routes/scan.ts`, `web/src/components/AlertsPanel.tsx`

---

## Problem

The alert subscription flow (`POST /api/alerts`) seeds the watched-repo list
exclusively from the subscriber's own non-fork, non-private repositories (up
to 15, sorted by stars). The `/api/scan` endpoint already accepts any
`owner/repo` or `owner` target via `parseTarget` + `isValidName`. The watch
store (`watched_repos`, `getWatchedRepos`, `setWatchedRepos`) is a generic
`(login, full_name)` set with no ownership check. The cron loop iterates
whatever strings are in that table without validating ownership.

The asymmetry: **scan any, watch only self**. Researchers and maintainers who
monitor namespaces they don't own — upstream dependencies, partner projects,
orgs they administer but don't sign in as — cannot receive alerts without
manually running the on-demand scan daily.

---

## 1. Input path — repo-only vs. namespace watching

**Recommendation: repo-only, not namespace-level watching.**

Each watched entry in `watched_repos` becomes one GitHub Search API call per
cron run. A namespace target (e.g., `vercel`) could expand to tens or hundreds
of repos, and that expansion would happen invisibly at subscribe time without
clear cost feedback to the user. `parseTarget` already returns a discriminated
union (`{ kind: 'repo' }` | `{ kind: 'account' }`); accept only the `'repo'`
kind for watch targets.

**Input normalization:** Reuse `parseTarget` + `isValidName` exactly as
`/api/scan` does. The watch-add flow:

1. Accept a raw string from the user (URL, `owner/repo`, or bare
   `owner/repo` form).
2. Call `parseTarget(input)` — reject anything that returns `null` or
   resolves to `kind: 'account'`.
3. Return the canonical `owner/repo` full name from `target.owner + '/' +
   target.name`.
4. Enforce the per-user cap (see §2) before inserting.

This reuse means the same URL formats accepted by the scan panel work in the
watch-add input with no extra parsing logic.

---

## 2. Cap — per-user maximum watched count

**Recommendation: hard cap of 20 watched repos per user, enforced
server-side.**

Rationale:

- The current implicit cap is 15 (top-15 own repos by stars). Raising it to
  20 gives meaningful headroom for external watching (own 15 + ~5 externals)
  without multiplying cron cost more than ~1.3×.
- 20 is a round number easy to communicate in the UI ("Watch up to 20
  repositories").
- The cap must be checked in the route that adds a watch target, not in
  `setWatchedRepos`. `setWatchedRepos` currently deletes-then-inserts the
  entire list; switching to an add/remove model (see §4) means the cap check
  happens in the route handler before the INSERT.

Server-side enforcement: before inserting a new watch target, count current
rows for the login and return `HTTP 422` with `{ error: 'watch_cap_reached',
message: 'You can watch at most 20 repositories.' }` if the count is already
at or above 20.

---

## 3. Cost model and cron sharding

### Per-run cost formula

Each source repo in `watched_repos` triggers:

- 1 × `searchRepos` call (GitHub Search API, rate-limited to ~30 req/min for
  authenticated users)
- Up to 8 candidate snapshot fetches (`maxCandidates = 8`, concurrency 3),
  each making 4-7 REST calls (repo, readme, commits, tree, contributors,
  releases)

So for a single source repo the cost is roughly `1 + 8*5 = ~41` REST calls in
the worst case, dominated by the candidate snapshots.

Total cron cost per run:

```
REST calls ≈ Σ_subscribers (watched_repos_count × 41)
```

At 20 watched repos and N active subscribers:

```
N=50   → ~41,000 calls per cron run
N=500  → ~410,000 calls per cron run
```

GitHub's authenticated search quota is 30 req/min; REST is 5,000 req/hr per
token. Since the cron uses each **subscriber's own token** (stored as
`token_enc`), the cost is spread across subscriber tokens, not a single shared
key. This is a key architectural property: there is no shared GitHub rate
limit for the cron — each subscriber exhausts (or doesn't) their own quota.

The watch-any-repo feature does not change this model, because a user watching
an external repo still uses their own token to search and snapshot. The cost
per user scales with `watched_repos_count`, not with ownership.

### Is cron sharding needed now?

**Not yet, but the loop is O(N_subscribers) and runs sequentially in a single
Worker invocation.** Cloudflare Workers have a 30-second CPU time limit per
invocation (no hard wall-clock limit in Scheduled Workers, but the event is
bounded). The current sequential `for` loop in `runImpersonationScan` will
stall if subscriber count grows.

**Sharding design (when needed):** Add a `cursor` column to
`alert_subscriptions` (or a separate cron-state KV entry). Each cron
invocation processes a page of subscribers (e.g., 50) ordered by
`last_run_at ASC` (oldest-first ensures fairness). Store the last-processed
login as the cursor; next invocation picks up there. With a 5-minute cron
interval and 50 subscribers per page, the system can sustain ~14,400
subscribers/day before any subscriber goes more than 24 hours between scans.

**Gating decision:** The cap at 20 repos is safe to ship without sharding.
Add the cursor/page pattern as a follow-up when subscriber count exceeds ~200
active (at which point a 4,000-call sequential run risks timeout).

---

## 4. UX — AlertsPanel watch list management

The current `AlertsPanel` is single-action: subscribe with an email, then
unsubscribe. The watch list is completely opaque to the user.

### Recommended new flow

**Subscribe step (unchanged):** Email + double opt-in stays as-is. On
subscribe, the backend still auto-seeds up to 15 own repos as today, and seeds
their clone baseline.

**After verification — a watch list panel:**

- Display the current watch list (GET `/api/alerts` should return
  `watchedRepos: string[]` alongside the existing fields).
- Provide an "Add repo to watch" input accepting the same URL/`owner/repo`
  formats as ScanAnyPanel.
- Each listed repo has a "Remove" button (DELETE `/api/alerts/watch/:fullName`
  or a body-driven DELETE).
- Enforce the 20-repo cap with a client-side count check + server-side 422
  guard; show "Limit reached (20/20)" inline when at cap.

### API surface needed (new endpoints, design-only — not shipped in this spike)

```
POST   /api/alerts/watch   { target: string }  → { watchedRepos: string[] }
DELETE /api/alerts/watch   { target: string }  → { watchedRepos: string[] }
GET    /api/alerts          (existing, extend response)
```

`POST /api/alerts/watch` handler logic:
1. Auth + suspension check (reuse `requireNotSuspended`).
2. Rate-limit (reuse `ALERT_EMAIL` bucket or a new `ALERT_WATCH` bucket).
3. `parseTarget(target)` — reject null or `kind: 'account'`.
4. Validate parts with `isValidName` (already done by `parseTarget`).
5. Count current watched repos for the login; reject if ≥ 20.
6. Verify the repo exists on GitHub (`client.getRepo(owner, name)`) to give
   a clean 404 rather than silently watching a nonexistent repo.
7. Insert into `watched_repos`.
8. **Seed the baseline for the new target immediately** (see §5).
9. Return the full updated `watchedRepos` list.

`DELETE /api/alerts/watch` handler logic:
1. Auth check (no suspension gate — removal should always be allowed).
2. `parseTarget(target)` to normalize.
3. DELETE single row from `watched_repos` for (login, full_name).
4. Optionally delete the matching `known_clones` rows for that source repo
   so if the user re-adds the repo later it rescans cleanly. (Trade-off:
   deletion means re-adding re-fires alerts for clones already known. Keep
   the known_clones rows on remove and DELETE them only on full unsubscribe.)

---

## 5. Baseline seeding on add

**Current behavior (subscribe):** `findClonesForRepos` is called for all
seeded repos at subscribe time; results are inserted into `known_clones` with
`notified = true`. This means the first cron run only fires on clones that
appear *after* subscription.

**For externally-added repos:** The same seeding must happen when a new repo
is added via `POST /api/alerts/watch`. The handler should:

1. Call `findClonesForRepo(client, source, { now })` for the single new
   target.
2. Call `recordClones` with `notified: true` for the results.

This is identical to the subscribe-time logic, just scoped to one repo.
Without this step, adding a popular repo that already has many clones would
trigger an immediate alert on the next cron run for every existing clone —
which is noise, not signal.

**Edge case:** If the baseline search fails (GitHub 429 or network error), log
the failure but still insert the `watched_repos` row. The cron will pick it up
on the next run. In that case, the very first cron run for this repo will
report all current clones as "new" — acceptable degraded behaviour, clearly
documented.

---

## 6. Open questions

1. **Auth scope for external repos.** The cron uses the subscriber's stored
   `token_enc` to call `searchRepos` and `buildRepoSnapshot`. For public repos
   owned by others, this works fine with the default `public_repo` scope. No
   scope change needed for the watch-any feature — confirm this assumption
   holds if private org repos are ever considered.

2. **Repo existence check on add.** Should the route call `client.getRepo` to
   validate the target exists before inserting? Doing so gives a clean user-
   facing 404, but costs one extra API call per add. Omitting it means the
   cron silently skips the entry (it gets 0 matches) and the user never learns
   their watched repo didn't exist. Recommendation: do the existence check.

3. **What happens when a watched external repo is deleted?** If
   `owner/repo` is deleted on GitHub, `searchRepos` and `getRepo` return 404.
   The cron currently swallows errors per-subscriber. The entry will linger in
   `watched_repos` indefinitely. Consider: detect consistent 404s (e.g., 3
   consecutive cron runs) and auto-remove the row, notifying the user.

4. **Namespace watching as a premium tier?** If namespace watching is
   implemented later, the search-API cost multiplier (one search per repo in
   the namespace, per cron run) must gate on an explicit expansion: at
   subscribe time, enumerate the owner's public non-fork repos and add them as
   individual rows up to the cap. Do not store a namespace as a single row —
   that would require a different cron code path.

5. **Cap value calibration.** 20 is a reasonable starting point but untested
   against real user demand. The cap should be adjustable via an env var
   (`WATCH_REPO_CAP`, default 20) so it can be tuned without a code deploy.

6. **Cron sharding timeline.** Monitor `last_run_at` lag in the admin audit
   log. If any subscriber's scan falls more than 2 hours behind the intended
   daily schedule, it is time to implement the cursor-based page loop.
