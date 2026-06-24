# Plan 015 [SPIKE]: Design a public, token-authenticated scan API

> **Executor instructions**: This is a DESIGN/INVESTIGATION spike, not a
> build-everything plan. The deliverable is a written design doc + a list of
> resolved/open questions, and (optionally) a thin throwaway prototype to
> de-risk one unknown. Do NOT ship a production public endpoint from this plan —
> it ends at a design the maintainer approves. Update plan 015's row in
> `plans/README.md` when the design doc is written.

## Status

- **Priority**: P3
- **Effort**: M (design/spike; coarse)
- **Risk**: MED (a public scan endpoint adds abuse/quota surface against the shared GitHub rate budget)
- **Depends on**: none (but a real build later should follow 009's CSRF exemption note)
- **Category**: direction
- **Planned at**: commit `2abd6f3`, 2026-06-24

## Why this matters (product value)

The detection engine is already a pure, dependency-free typed contract — the SPA
imports its domain types directly across the package boundary (`web/src/api.ts`
imports from `src/engine`), and the only thing between `evaluateRepo`/
`evaluateAccount` and an external caller is the cookie-session route layer. The
README explicitly frames "vet a repo an AI coding agent suggested" as a primary
use case — and agents/CI want a programmatic `POST /api/scan` with a key, not a
SPA. This is the adjacent-possible capability the architecture most cheaply
supports. The spike's job is to define *how* to expose it safely, not to build it.

## Current state (grounding)

- `src/routes/scan.ts` — `GET /report`, `GET /scan?target=`, `GET /clones`,
  gated by `requireAuth` (cookie session) + `requireNotSuspended` + `rateLimit(...)`.
  `parseTarget` (156–172) already accepts a URL / `owner/repo` / `owner`.
- `src/routes/middleware.ts` — `requireAuth` resolves a session, attaches a
  `GitHubClient` built from the user's stored token, and the user record.
- `src/routes/rate-limit.ts` — per-login `rateLimit(...tiers)` middleware +
  `SCAN_BURST`/`SCAN_DAILY` tiers; admins exempt.
- A scan uses the **caller's own GitHub token** for API quota; a public API needs
  to decide whose token/quota is used (the key owner's? a service token?).

## Deliverable

A design doc at `docs/proposals/015-public-scan-api.md` (create the `docs/proposals/`
dir) covering the decisions below, plus this plan's row updated. No production
route is added by this plan.

## Investigate & decide (write the answers into the doc)

1. **Auth model** for non-cookie callers: an API key / PAT issued per user
   (stored hashed, like session ids), passed as `Authorization: Bearer <key>`.
   How is it minted/revoked (a new `api_keys` table + an admin/self UI)? How does
   it map to a GitHub token for the actual API calls — reuse the key owner's
   stored OAuth token, or require the caller to pass their own GitHub token?
2. **Scope of the endpoint**: which scans are exposed (`repo`/`account` are
   safe + bounded; `clones` is the most expensive — include it?). Response
   contract: reuse the engine's JSON types (cite them) so external callers get a
   documented schema.
3. **Rate limiting** per key (not per login): new tiers? The shared GitHub search
   secondary-limit budget is the scarce resource — what per-key cap protects it?
4. **CSRF/relationship to plan 009**: token-authenticated requests must be
   **exempt** from the `csrf()` Origin check (CSRF only applies to ambient/cookie
   auth) — note exactly how (e.g. apply `csrf()` only when no `Authorization`
   header is present).
5. **Abuse surface**: what stops a key from being a free GitHub-scanning proxy?
   (per-key quota, suspended-user check, logging via `recordScan`.)
6. **Open questions** the maintainer must answer before a build plan.

## Optional thin prototype (de-risk only)

If one unknown is load-bearing (most likely #1: key→token mapping), build a
*throwaway* spike behind an off-by-default flag — e.g. a `POST /api/v1/scan` that
accepts a Bearer key, looks up a hashed key row, and runs `evaluateRepo` for a
single `owner/repo` — to prove the auth+engine wiring. Mark it clearly as a
prototype (not production), keep it out of the default route mounting, and do
NOT add the `api_keys` UI/issuance. Remove it or gate it before finishing if it
isn't wanted yet.

## Done criteria

- [ ] `docs/proposals/015-public-scan-api.md` exists and answers items 1–6 with
      concrete recommendations + trade-offs (not just questions)
- [ ] It cites the exact engine response types to reuse and the rate-limit reuse plan
- [ ] If a prototype was built, it is flag-gated/removed and not in the default routes
- [ ] `plans/README.md` row for 015 updated (status reflects "design done")

## STOP conditions

- You find yourself building the production `api_keys` table + issuance UI + full
  endpoint — STOP; that's the *next* plan, gated on maintainer approval of this
  design.
- The key→GitHub-token model has a security implication you can't resolve (e.g.
  reusing a user's OAuth token for third-party-triggered scans) — document it as
  the central open question and stop; don't guess.

## Maintenance notes

- A real build should land after 009 (CSRF) so the Origin-exemption for token
  auth is already designed, and reuse `recordScan` for analytics/abuse velocity.
