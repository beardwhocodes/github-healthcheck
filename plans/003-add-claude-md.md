# Plan 003: Add a `CLAUDE.md` that encodes this repo's non-obvious rules

> **Executor instructions**: Follow step by step. Verify each documented command
> actually runs. Honor "STOP conditions". When done, update plan 003's row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2abd6f3..HEAD -- package.json .github/workflows/deploy.yml migrations`
> If these changed, re-confirm the commands/rules below against the live repo
> before writing them into `CLAUDE.md`.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (adds a doc; no code changes)
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `2abd6f3`, 2026-06-24

## Why this matters

This repo is routinely worked on by AI agents, and its most important rules are
*implicit*: deploys happen only in CI (the local `deploy` script is a guard that
errors), migrations are append-only numbered files (never edit `0001_baseline.sql`),
the engine in `src/engine/` is pure and must stay I/O-free, and there are four
distinct verification commands (`pnpm test` does **not** run the integration
suite). With no `CLAUDE.md`/`AGENTS.md`, every agent re-derives or violates these
each session — attempting a local deploy, editing the baseline migration, or
skipping `test:integration`. A short rules file is disproportionately valuable here.

## Current state

- No `CLAUDE.md` or `AGENTS.md` exists (`ls CLAUDE.md AGENTS.md` → none).
- Verified facts to encode (confirm each before writing it):
  - Verification commands (from `package.json` scripts): `pnpm typecheck`,
    `pnpm test`, `pnpm test:integration`, `pnpm build:web`, and
    `pnpm exec wrangler deploy --dry-run`.
  - `package.json` `deploy` script: `echo '...Do not deploy from a local
    machine.' && exit 1` — deploys are CI-only via `.github/workflows/deploy.yml`
    on push to `master`.
  - Migrations: `migrations/NNNN_*.sql`, applied once in filename order; add a
    new numbered file, never edit an applied one. Local apply: `pnpm run db:init`.
  - Package manager is **pnpm** (`packageManager: pnpm@10.28.1`); `cache: pnpm`
    in CI.
  - Engine purity: `src/engine/` is pure (no D1/fetch); rules are unit-tested in
    `tests/repo-rules.spec.ts` / `tests/evaluate.spec.ts`.
  - Store layer maps DB `snake_case` → JS `camelCase` by hand in each
    `src/*/store.ts` (`rowToX` mappers); D1 has **no JSON-typed columns**.
  - Positional-bind discipline for dynamic SQL is documented inline at
    `src/users/store.ts:149-152` — keep bind order matching placeholder order.
  - `web/` is a React/Vite SPA; `pnpm build:web` runs `vite build` **then**
    `node scripts/prerender.mjs` (build-time homepage prerender). Don't remove
    the prerender step.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| Integration | `pnpm test:integration` | all pass |
| Build SPA | `pnpm build:web` | exit 0, prerender injects HTML |
| Worker dry-run | `pnpm exec wrangler deploy --dry-run` | exit 0 |

## Scope

**In scope**: `CLAUDE.md` (create, at repo root).
**Out of scope**: every other file. Do not "fix" anything you notice while
writing the doc — just document what is true today.

## Git workflow

- Branch: `advisor/003-add-claude-md`
- One commit: `Add CLAUDE.md with verification + deploy/migration rules`.

## Steps

### Step 1: Confirm every command and rule is accurate

Run each command in the table above and confirm it behaves as documented (e.g.
`pnpm test:integration` runs the `*.itest.ts` suite; the `deploy` script errors).
Open `package.json`, `.github/workflows/deploy.yml`, and `migrations/` to confirm
the rules. **Do not write a rule you have not verified.**

**Verify**: each command exits as expected.

### Step 2: Write `CLAUDE.md`

Create `CLAUDE.md` at the repo root with these sections (concise; this is a rules
file, not prose):

1. **What this is** — one paragraph: GitHub Healthcheck, Cloudflare Workers +
   Hono backend (`src/`), React/Vite SPA (`web/`), D1 + cron.
2. **Verify before you finish** — the five commands and when each applies
   (typecheck always; `pnpm test` = node unit; `pnpm test:integration` = Workers
   pool + D1, run it when touching `src/*/store.ts`, auth, routes, or cron;
   `build:web` when touching `web/`; `wrangler deploy --dry-run` when touching
   the Worker bundle/`wrangler.jsonc`).
3. **Hard rules** — deploys are CI-only (never run a local deploy); migrations
   are append-only (add `migrations/NNNN_name.sql`, never edit an applied one;
   `pnpm run db:init` to apply locally); keep `src/engine/` pure (no I/O);
   package manager is pnpm only.
4. **Conventions** — store layer hand-maps snake→camel in `rowToX` (no JSON
   columns in D1); dynamic SQL keeps positional binds in placeholder order (see
   `src/users/store.ts:149`); the SPA build includes a prerender step
   (`scripts/prerender.mjs`) — keep it.
5. **Layout** — one-line pointers: `src/engine` (pure scoring), `src/routes`
   (Hono handlers + middleware), `src/auth` (OAuth/sessions/crypto), `src/github`
   (API client), `src/alerts` (cron + email), `src/*/store.ts` (D1), `web/src`
   (SPA).

Keep it under ~60 lines. Prefer a bulleted rules list over paragraphs.

**Verify**: `CLAUDE.md` exists; every command it names runs as described
(re-run any you're unsure of).

## Test plan

- No code tests. The "test" is that each command/rule in `CLAUDE.md` is
  verified by running it in Step 1.

## Done criteria

- [ ] `CLAUDE.md` exists at repo root with the 5 sections above
- [ ] Every command named in it has been run and behaves as documented
- [ ] No rule is stated that contradicts the live repo (spot-check migrations are append-only, deploy script errors, `src/engine` has no `fetch`/`DB`)
- [ ] `git status` shows only `CLAUDE.md` created
- [ ] `plans/README.md` row for 003 updated

## STOP conditions

- A command documented here does NOT behave as described (e.g. `pnpm
  test:integration` fails to run) — STOP and report; don't paper over it in the doc.

## Maintenance notes

- Keep `CLAUDE.md` in sync when scripts, the deploy flow, or the migration
  convention change. A reviewer should reject any future PR that contradicts it
  without updating it.
