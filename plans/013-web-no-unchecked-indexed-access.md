# Plan 013: The SPA compiles under `noUncheckedIndexedAccess`

> **Executor instructions**: Follow step by step; verify each step. Honor "STOP
> conditions". Update plan 013's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2abd6f3..HEAD -- web/tsconfig.json web/src`
> If `web/src` changed materially, expect a different set of surfaced errors;
> proceed but re-evaluate the count against the STOP condition.

## Status

- **Priority**: P3
- **Effort**: S–M (flag is one line; fixing the surfaced errors is the work)
- **Risk**: MED (enabling the flag surfaces new type errors that must be handled)
- **Depends on**: 004 (recommended — land the linter first so both gate changes review together)
- **Category**: dx
- **Planned at**: commit `2abd6f3`, 2026-06-24

## Why this matters

The root `tsconfig.json` enables `noUncheckedIndexedAccess` (so array/record
indexing yields `T | undefined` and must be guarded), but `web/tsconfig.json`
does **not** — so the SPA can index records by server-supplied strings without
the compiler flagging a possible `undefined`. Sites like
`CATEGORY_PILL[report.category]`, `STATUS_PILL[m.status]`, `KIND_LABEL[s.kind]`
are safe today only because the backend validates those enums; a schema drift
would crash a render (`.className` on `undefined`) with no compile-time warning.
Aligning the SPA with the backend's strictness closes that gap and matches the
repo's existing standard.

## Current state

- `web/tsconfig.json` sets `"strict": true` (+ `noUnusedLocals`,
  `noUnusedParameters`, `verbatimModuleSyntax`, `isolatedModules`) but **not**
  `noUncheckedIndexedAccess`. Root `tsconfig.json` has it.
- Likely surfaced sites (the compiler will list the authoritative set):
  - `web/src/components/admin/AdminReports.tsx` — `CATEGORY_PILL[report.category]`
  - `web/src/components/admin/AdminInbox.tsx` — `STATUS_PILL[m.status]`
  - `web/src/components/admin/AdminScans.tsx` — `KIND_LABEL[s.kind]` (already
    guarded with `?? s.kind` in places — pattern to copy)
  - possibly array indexing in `web/src/report.ts`, `nav.ts`, etc.
- Typecheck command: `pnpm typecheck` runs `tsc -p tsconfig.json --noEmit && tsc
  -p web/tsconfig.json --noEmit` — the second invocation is the one this changes.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm typecheck` | exit 0 once errors are fixed |
| Web typecheck only | `pnpm exec tsc -p web/tsconfig.json --noEmit` | exit 0 |
| Build SPA | `pnpm build:web` | exit 0 |
| Lint (if 004 landed) | `pnpm lint` | exit 0 |

## Scope

**In scope**: `web/tsconfig.json` (the flag), plus the `web/src/**` files the
flag surfaces — each fixed with a sensible fallback or a justified non-null
assertion.
**Out of scope**: the root `tsconfig.json` (already strict); changing runtime
behavior beyond adding fallbacks; `src/` (backend).

## Git workflow

- Branch: `advisor/013-web-no-unchecked-indexed-access`
- One commit: `Web: enable noUncheckedIndexedAccess and guard indexed access`.

## Steps

### Step 1: Enable the flag

Add to `web/tsconfig.json` `compilerOptions`:
```json
"noUncheckedIndexedAccess": true,
```

**Verify**: `pnpm exec tsc -p web/tsconfig.json --noEmit` → now lists the
indexing errors. **Count them.** If there are more than ~15, STOP and report the
list before fixing (the scope may be larger than estimated).

### Step 2: Fix each surfaced site

For each error, apply the minimal correct guard:
- Record lookup that has a sensible default → `MAP[key] ?? FALLBACK` (copy the
  existing `KIND_LABEL[s.kind] ?? s.kind` pattern).
- Lookup that is provably present (key came from a closed union you control) →
  `MAP[key]!` with a short `// safe: key is a closed union` comment, used
  sparingly.
- Array index that may be empty → guard or default before use.

Do not change rendered output for the valid cases — only add the
undefined-handling path.

**Verify**: `pnpm exec tsc -p web/tsconfig.json --noEmit` → exit 0;
`pnpm typecheck` → exit 0.

### Step 3: Build still works

**Verify**: `pnpm build:web` → exit 0; `grep -c "cloned to spread malware"
web/dist/index.html` → 1 (prerender intact). If 004 landed, `pnpm lint` → exit 0.

## Test plan

- No new tests (a compiler-strictness change). The gate is `pnpm typecheck`
  exiting 0 with the flag on, plus `pnpm build:web` succeeding.

## Done criteria

- [ ] `web/tsconfig.json` has `"noUncheckedIndexedAccess": true`
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm build:web` exits 0; prerender intact (`grep` check above)
- [ ] Fixes use fallbacks/guards, not `as any` or `// @ts-ignore`
- [ ] `git status` shows only `web/tsconfig.json` + the surfaced `web/src` files
- [ ] `plans/README.md` row for 013 updated

## STOP conditions

- More than ~15 errors surface — STOP, report the list; the maintainer may want
  to scope it down or accept a follow-up.
- A fix would change behavior for a *valid* input (not just the undefined edge) —
  that means the guard is wrong; rethink it.
- You're reaching for `as any`/`@ts-ignore` to silence an error — STOP; that
  defeats the purpose. Use a real guard or a justified `!`.

## Maintenance notes

- New record/array indexing in `web/src` now must handle `undefined`; reviewers
  should reject `as any` workarounds.
- Pairs with plan 004 (linter); together they bring the SPA's static-checking up
  to the backend's bar.
