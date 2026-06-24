# Plan 004: A linter (Biome) runs locally and gates CI

> **Executor instructions**: Follow step by step; run every verification command
> and confirm the result. Honor "STOP conditions". When done, update plan 004's
> row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2abd6f3..HEAD -- package.json .github/workflows/deploy.yml`
> If these changed, re-confirm the script list and the CI `build-test` job steps
> before editing.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (additive; lint-only, no auto-reformat)
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `2abd6f3`, 2026-06-24

## Why this matters

The repo has `tsc --noEmit` but **no linter** — no eslint/prettier/biome config,
no `lint` script. `tsc` catches type errors but not the class a linter does:
React hooks exhaustive-deps (the SPA has several `useEffect`s), accessibility
issues, unused/suspicious patterns, and inconsistent code. For a repo where
agents execute changes, a fast lint gate is the cheapest automated reviewer.
This plan adds **Biome** (single binary, no plugins) as a **linter only**
(formatting left for a separate opt-in to avoid a giant reformat diff), and wires
it into CI.

## Current state

- `package.json` scripts: `typecheck`, `test`, `test:integration`, `build:web`,
  etc. — **no `lint`**. Dependencies are minimal; pnpm is the package manager
  (`packageManager: pnpm@10.28.1`).
- `.editorconfig` exists (governs whitespace only). No eslint/prettier/biome.
- CI `build-test` job in `.github/workflows/deploy.yml` runs (in order):
  checkout → pnpm/action-setup → setup-node(cache: pnpm) → `pnpm install
  --frozen-lockfile` → **Typecheck** → Unit tests → Integration tests → Build
  SPA → Dry-run. We add a **Lint** step right after Typecheck.
- Observed code style (match it in config so lint doesn't fight it): single
  quotes, 2-space indent, semicolons, trailing commas, ~100-char lines, ESM with
  `verbatimModuleSyntax`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Install | `pnpm install` | exit 0 |
| Lint (CI mode, non-mutating) | `pnpm lint` | exit 0 once findings are resolved |
| Lint autofix (local) | `pnpm exec biome check --write .` | applies safe fixes |
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test` && `pnpm test:integration` | all pass |

## Scope

**In scope**:
- `package.json` (add `@biomejs/biome` devDep + `lint` script)
- `biome.json` (create)
- `.github/workflows/deploy.yml` (add the Lint step)
- `pnpm-lock.yaml` (updated by the install)
- Source files **only** where a lint finding is genuinely fixed (small, targeted)

**Out of scope**:
- Do NOT enable the Biome **formatter** in this plan (`"formatter": { "enabled":
  false }`). A repo-wide reformat is a separate decision — keep this diff small.
- Do NOT mass-rewrite code to satisfy stylistic rules. Prefer tuning a noisy rule
  off/`warn` in `biome.json` over editing dozens of files (see Step 3).

## Git workflow

- Branch: `advisor/004-add-biome-lint`
- Commit(s): one for setup, optionally one for the triaged fixes. Message e.g.
  `Add Biome lint gate (linter only) + CI step`.

## Steps

### Step 1: Add Biome and config

Add the dev dependency (pin the current 2.x):
`pnpm add -D @biomejs/biome`

Create `biome.json` (linter on, formatter off, style matched so it doesn't churn):

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "ignoreUnknown": true },
  "formatter": { "enabled": false },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true }
  },
  "javascript": { "formatter": { "quoteStyle": "single" } }
}
```

(Adjust the `$schema` version to the installed Biome version. Biome auto-ignores
`node_modules`, `dist`, and respects `.gitignore` via `useIgnoreFile`.)

Add scripts to `package.json`:
- `"lint": "biome ci ."` (non-mutating check used by CI and locally)

**Verify**: `pnpm exec biome --version` prints a version; `pnpm lint` runs (it
will likely report findings — that's expected; Step 3 resolves them).

### Step 2: Auto-fix the safe findings

Run `pnpm exec biome check --write .` to apply Biome's safe autofixes, then
`pnpm exec biome check --write --unsafe .` only if you review the diff and it's
clearly correct. Re-run `pnpm typecheck` and `pnpm test` after.

**Verify**: `pnpm typecheck` exit 0; `pnpm test` all pass.

### Step 3: Triage the remainder — fix small, tune noisy

For findings that remain after autofix, decide per rule:
- **Genuine, small fix** (e.g. a real unused import, a missing hook dependency
  that is safe to add) → fix it in the source file.
- **Noisy/stylistic or large-footprint rule** (would require editing many files,
  or conflicts with a deliberate pattern like the `Record<string, unknown>`
  casts in `src/github/snapshot.ts`) → set that specific rule to `"warn"` or
  `"off"` in `biome.json` with a trailing reason, rather than hand-editing.

The goal is `pnpm lint` exiting 0 with a **small** source diff. If clearing the
findings would touch more than ~10 source files, prefer tuning rules off and note
them for a follow-up cleanup.

**Verify**: `pnpm lint` → exit 0. `pnpm typecheck` → exit 0. `pnpm test` &&
`pnpm test:integration` → all pass.

### Step 4: Wire Lint into CI

In `.github/workflows/deploy.yml`, in the `build-test` job, add a step
**immediately after** the `Typecheck` step:

```yaml
      - name: Lint
        run: pnpm lint
```

**Verify**: `grep -n "name: Lint" .github/workflows/deploy.yml` matches, placed
after `name: Typecheck`. (CI itself runs on push; you cannot run it locally —
confirm the YAML is valid by eye and that `pnpm lint` passes locally.)

## Test plan

- No new unit tests. The gate itself (`pnpm lint`) is the verification.
- Confirm the existing suites are unaffected: `pnpm test` and
  `pnpm test:integration` both green after any autofixes.

## Done criteria

- [ ] `pnpm lint` exits 0
- [ ] `biome.json` exists with `formatter.enabled: false` and `linter.enabled: true`
- [ ] `package.json` has a `lint` script and `@biomejs/biome` in devDependencies
- [ ] `.github/workflows/deploy.yml` has a `Lint` step after `Typecheck`
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm test:integration` all still pass
- [ ] Source diff is small and intentional (no repo-wide reformat)
- [ ] `plans/README.md` row for 004 updated

## STOP conditions

- Autofix (`--write`) produces a diff you don't understand or that changes
  behavior — revert it (`git checkout -- <files>`) and fix by hand or tune the
  rule instead.
- Clearing lint findings would require editing a large number of files — STOP,
  tune the offending rules off in `biome.json`, and report which rules you
  deferred (so a follow-up can address them).
- A Biome autofix breaks a test — revert that fix.

## Maintenance notes

- Formatting is intentionally deferred. A follow-up can flip `formatter.enabled:
  true` and run a one-shot `biome format --write .` (large mechanical diff) once
  the team agrees on the format.
- Biome is a *syntactic* linter — it does NOT do type-aware rules like
  no-floating-promises. If type-aware lint is wanted later, that's a separate
  (heavier) `typescript-eslint` setup, not Biome.
- Plan 013 (`noUncheckedIndexedAccess` in `web/`) pairs with this — land 004
  first so both gate changes are reviewed together.
