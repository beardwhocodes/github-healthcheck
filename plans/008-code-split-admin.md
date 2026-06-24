# Plan 008: The admin dashboard is code-split out of the main bundle

> **Executor instructions**: Follow step by step; verify each step. Honor "STOP
> conditions". Update plan 008's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2abd6f3..HEAD -- web/src/App.tsx web/src/components/admin/AdminPanel.tsx`
> If either changed, compare excerpts to live code; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `2abd6f3`, 2026-06-24

## Why this matters

The SPA ships as a **single** JS chunk (~197 KB raw / ~61 KB gz), with zero
dynamic imports. `web/src/App.tsx` statically imports `AdminPanel`, which
statically pulls all six admin sub-views (Overview, Users, Scan log, Inbox,
Reported repos, Audit log) and their tables/charts. So **every signed-in
non-admin downloads and parses the entire admin dashboard they can never reach** —
the largest, least-used slice of the app. Lazy-loading the admin tree splits it
into a chunk fetched only when an admin opens that tab.

## Current state

- `web/src/App.tsx`:
  - line 7: `import { AdminPanel } from './components/admin/AdminPanel.js';`
  - line ~172 (inside `SignedInApp`): `{activeTab === 'admin' && <AdminPanel />}`
  - A spinner pattern already exists for loading states:
    `<div className="center-state"><span className="spinner" /></div>`.
- `web/src/components/admin/AdminPanel.tsx` statically imports the six sub-views
  (lines 3–8). (You do NOT need to change this file — splitting at `AdminPanel`
  pulls its whole subtree into the lazy chunk.)
- `web/src/main.tsx` mounts via `createRoot` (React 18). `React.lazy` + `Suspense`
  are available.
- Build: `pnpm build:web` (Vite) emits hashed chunks to `web/dist/assets/`. Today
  there is exactly one `index-*.js`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm typecheck` | exit 0 |
| Build SPA | `pnpm build:web` | exit 0; now emits ≥2 JS chunks |
| List JS chunks | `ls web/dist/assets/*.js` | more than one file |

## Scope

**In scope**: `web/src/App.tsx`.
**Out of scope**: `AdminPanel.tsx` and the admin sub-views (no change needed);
`vite.config.ts` (no manualChunks needed — the dynamic import creates the split);
the prerender (`scripts/prerender.mjs`) — it renders the signed-out `SignedOut`
tree only, which doesn't touch admin, so it's unaffected.

## Git workflow

- Branch: `advisor/008-code-split-admin`
- One commit: `Web: lazy-load the admin dashboard into its own chunk`.

## Steps

### Step 1: Lazy-import `AdminPanel`

In `web/src/App.tsx`, replace the static import (line 7) with a lazy one and add
`lazy, Suspense` to the React import:

```tsx
import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
// ...remove: import { AdminPanel } from './components/admin/AdminPanel.js';
const AdminPanel = lazy(() =>
  import('./components/admin/AdminPanel.js').then((m) => ({ default: m.AdminPanel })),
);
```

(`AdminPanel` is a named export, hence the `.then(... default ...)` mapping.)

### Step 2: Wrap the admin render in `Suspense`

Change the admin branch in `SignedInApp` to provide a fallback while the chunk
loads:

```tsx
{activeTab === 'admin' && (
  <Suspense fallback={<div className="center-state"><span className="spinner" /></div>}>
    <AdminPanel />
  </Suspense>
)}
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Build and confirm the split

**Verify**: `pnpm build:web` → exit 0; `ls web/dist/assets/*.js` lists **more
than one** `.js` file (a separate admin chunk now exists), and the main
`index-*.js` is smaller than before (~197 KB → noticeably less). Confirm
`web/dist/index.html` still contains the prerendered landing (`grep -c "cloned to
spread malware" web/dist/index.html` → 1) — proves the prerender step is intact.

## Test plan

- No new unit test (this is a bundling change; behavior is identical). If you
  want a smoke check: serving `web/dist` and opening the admin tab should fetch
  the new chunk on demand — optional, not required for done.
- Verification is the build emitting a separate chunk (Step 3).

## Done criteria

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm build:web` exits 0 and `ls web/dist/assets/*.js | wc -l` ≥ 2
- [ ] `grep -n "lazy(" web/src/App.tsx` matches; the static `AdminPanel` import is gone
- [ ] `grep -c "cloned to spread malware" web/dist/index.html` → 1 (prerender intact)
- [ ] `git status` shows only `web/src/App.tsx`
- [ ] `plans/README.md` row for 008 updated

## STOP conditions

- The build errors about the dynamic import / named export — re-check the
  `.then((m) => ({ default: m.AdminPanel }))` mapping (AdminPanel is not a default
  export).
- After the change the admin tab renders nothing / a permanent spinner — the
  `Suspense` fallback or the lazy import path is wrong; fix before marking done.

## Maintenance notes

- If more rarely-used surfaces appear (e.g. a future settings page), apply the
  same `lazy` + `Suspense` pattern.
- A reviewer should confirm the admin tab still works (loads its chunk) and the
  signed-out prerender is unchanged.
