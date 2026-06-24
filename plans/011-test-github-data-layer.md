# Plan 011: Characterization tests for the GitHub client + clone-detection pipeline

> **Executor instructions**: Follow step by step; verify each step. Honor "STOP
> conditions". Update plan 011's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2abd6f3..HEAD -- src/github/client.ts src/github/clone-detection.ts`
> If either changed, compare excerpts to live code; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (adds tests only)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `2abd6f3`, 2026-06-24

## Why this matters

The GitHub client (`src/github/client.ts`) and the clone-detection pipeline
(`src/github/clone-detection.ts`) are the data-acquisition layer the entire
product runs on, and both have **zero tests**. The client's parsing/clamping/
error-mapping (README base64 decode + 256 KB cap, the contributor-count Link-
header regex, empty-repo `409`→`[]`, the `403/429` + `x-ratelimit-remaining: 0`
→ `GitHubApiError(429)` branch) is exactly the kind that breaks silently on a
GitHub API shape change. The clone pipeline's candidate filtering and
highest-confidence-per-suspect dedupe directly set the false-positive/negative
rate of the headline feature. These are pure-ish functions tested with standard
vitest mocking — no Workers runtime needed.

## Current state

- `src/github/client.ts` — `GitHubClient` (methods use a private `request()` that
  calls global `fetch`); `isValidName` (pure); `GitHubApiError`. Key behaviors to
  pin (read the file for exact shapes):
  - `request()` (lines 47–63): on `403`/`429` with header `x-ratelimit-remaining:
    '0'` throws `GitHubApiError(..., 429)`.
  - `getReadme` (108–116): `404`→`null`; base64 decode when `encoding==='base64'`;
    truncates to `README_MAX_CHARS` (256·1024).
  - `getRecentCommits` (118–123): `409`/`404`→`[]`.
  - `getContributorsCount` (134–144): parses `link` header `rel="last"` page
    number; falls back to `data.length`; `!ok`→`null`.
  - `listRepos` (83–102): paginates until a short page or `maxPages`.
  - `isValidName` (21–23): regex + rejects `..`.
- `src/github/clone-detection.ts` — `findClonesForRepo` (candidate filter at
  33–46: same name, different owner, not the source; `slice(maxCandidates)`;
  `minConfidence` gate) and `findClonesForRepos` (highest-confidence-per-suspect
  dedupe at 96–105). Both take `client: GitHubClient` as a parameter → inject a
  fake; no mock library needed.
- Test conventions: `tests/*.spec.ts`, node env (`pnpm test`). For the client,
  mock global fetch with `vi.stubGlobal('fetch', vi.fn(...))` (standard vitest).
  Model structure on `tests/scan-stats.spec.ts`.
- **Do NOT** test `mapWithConcurrency` here — that primitive is covered by plan
  006 (`tests/snapshot.spec.ts`). Avoid the overlap.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm typecheck` | exit 0 |
| Run these tests | `pnpm test -- github-client` and `pnpm test -- clone-detection` | pass |
| Full unit suite | `pnpm test` | all pass |

## Scope

**In scope**: `tests/github-client.spec.ts` (create), `tests/clone-detection.spec.ts` (create).
**Out of scope**: any `src/` file (tests only — if a test reveals a real bug,
STOP and report it, don't fix it here); `mapWithConcurrency`/`snapshot.ts` tests
(owned by plan 006).

## Git workflow

- Branch: `advisor/011-test-github-data-layer`
- Commit(s): `Test: characterize the GitHub client and clone-detection pipeline`.

## Steps

### Step 1: `tests/github-client.spec.ts` (fetch-mocked)

Use `vi.stubGlobal('fetch', vi.fn())` per test to return crafted `Response`s
(`new Response(JSON.stringify(...), { status, headers })`). Reset with
`vi.unstubAllGlobals()` in `afterEach`. Cover:
- `isValidName`: accepts `'octocat'`, `'a.b-c_d'`; rejects `'../x'`, `''`,
  `'has/slash'`, a 101-char name.
- rate limit: a `403` response with `x-ratelimit-remaining: '0'` makes
  `getAuthenticatedUser()` reject with `GitHubApiError` whose `.status === 429`.
- `getReadme`: `404`→`null`; a base64 `content` with `encoding:'base64'` decodes
  to the expected text; a >256 KB decoded body is truncated to 256·1024 chars.
- `getRecentCommits`: `409`→`[]`.
- `getContributorsCount`: a `link` header `<...&page=42>; rel="last"` → `42`; no
  link header → `data.length`; non-ok → `null`.
- `listRepos`: with a full first page then a short second page, pages stop and
  concatenate (assert the fetch was called twice, results merged).

### Step 2: `tests/clone-detection.spec.ts` (injected fake client)

Build a minimal fake `GitHubClient` object (cast `as unknown as GitHubClient`)
providing the methods the path calls (`searchRepos`, plus the snapshot methods
`getReadme`/`getRecentCommits`/`getContributorsCount`/`getReleaseAssets`/
`getCommitFiles`/`getTreePaths` returning benign canned values). Cover:
- `findClonesForRepo` filters out candidates that are the source repo, owned by
  the source owner, or have a different name; honors `maxCandidates` slice.
- `minConfidence` gate: a candidate scoring below the threshold is excluded.
- `findClonesForRepos`: when the same suspect surfaces for two sources, the
  result keeps the **highest-confidence** instance (no duplicate suspect rows).

(If shaping `searchRepos`/snapshot fakes to hit a precise confidence is fiddly,
assert the structural invariants — candidate filtering and dedupe-by-suspect —
which are the load-bearing logic.)

**Verify**: `pnpm test -- clone-detection` and `pnpm test -- github-client` pass;
`pnpm test` all green; `pnpm typecheck` exit 0.

## Test plan

- Two new files (cases above). Pattern: `tests/scan-stats.spec.ts` for structure;
  the fake-client injection mirrors how `findClonesForRepo` already takes `client`.
- Verification: `pnpm test` all pass; `pnpm typecheck` exit 0.

## Done criteria

- [ ] `pnpm test` exits 0 with both new files passing
- [ ] `pnpm typecheck` exits 0
- [ ] The rate-limit (`429`), README-cap, and dedupe-by-suspect cases are all present
- [ ] `git status` shows only the two new test files
- [ ] `plans/README.md` row for 011 updated

## STOP conditions

- A test that should pass on correct code fails — you've found a real bug
  (e.g. the Link-header regex doesn't parse a real header, or dedupe keeps the
  wrong instance). STOP and report it rather than bending the test.
- `vi.stubGlobal('fetch', ...)` doesn't intercept `client`'s fetch — confirm the
  client uses the global `fetch` (it does) and that you stubbed before
  constructing/calling; if still stuck, STOP.

## Maintenance notes

- These pin the current GitHub API contract. If GitHub changes a response shape
  (e.g. the contributors Link header), a test fails — update it deliberately.
- Plan 006 adds `tests/snapshot.spec.ts` (the pool + `buildRepoSnapshotSafe`);
  together with these, the scanning data layer is covered end-to-end except the
  live network, which is intentionally out of scope.
