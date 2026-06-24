# CLAUDE.md — GitHub Healthcheck

## What this is
GitHub Healthcheck lets users sign in with GitHub and receive a security report
for their account and repositories (detecting the orchidfiles malware-clone
campaign). Backend: Cloudflare Workers + Hono (`src/`), D1 database, cron
alerts. Frontend: React/Vite SPA (`web/`). Package manager: pnpm.

## Verify before you finish

Run these commands and confirm they exit 0 before considering any change done.

| Command | What it checks | When required |
|---|---|---|
| `pnpm typecheck` | TypeScript across `src/` and `web/` | Always |
| `pnpm test` | Node-side unit tests (`tests/*.spec.ts`) | Always |
| `pnpm test:integration` | Workers pool + D1 (`tests/integration/*.itest.ts`) | When touching `src/*/store.ts`, auth, routes, or cron |
| `pnpm build:web` | Vite build + prerender step | When touching `web/` |
| `pnpm exec wrangler deploy --dry-run` | Worker bundle compiles | When touching the Worker bundle or `wrangler.jsonc` |

## Hard rules

- **Deploys are CI-only.** `pnpm run deploy` intentionally errors. Deploys
  happen automatically via `.github/workflows/deploy.yml` on push to `master`.
  Never attempt a local deploy.
- **Migrations are append-only.** Files live in `migrations/NNNN_*.sql` and
  are applied once, in filename order. Add a new numbered file; never edit an
  already-applied migration (especially not `0001_baseline.sql`). Apply locally
  with `pnpm run db:init`.
- **`src/engine/` must stay pure.** No `fetch`, no `env.DB`, no I/O of any
  kind. The engine is unit-tested in `tests/repo-rules.spec.ts` and
  `tests/evaluate.spec.ts`; keep it that way.
- **pnpm only.** Do not use npm or yarn.

## Conventions

- **Store layer hand-maps snake_case → camelCase.** D1 returns raw column
  names; each `src/*/store.ts` maps them explicitly. There are no JSON-typed
  columns, so no `JSON.parse` is needed at the store layer.
- **Positional-bind discipline.** Dynamic SQL assembles `?` placeholders in a
  strict order: subquery binds first, then `WHERE` clause binds, then `LIMIT`.
  The binds array must mirror that order exactly. See the comment at
  `src/users/store.ts:149` for the canonical explanation.
- **SPA build includes prerender.** `pnpm build:web` runs `vite build` then
  `node scripts/prerender.mjs`. Do not remove or skip the prerender step; it
  injects landing-page HTML into `web/dist/index.html`.

## Layout

- `src/engine/` — pure scoring logic (no I/O): rules, evaluation, scoring,
  types
- `src/routes/` — Hono route handlers and middleware
- `src/auth/` — OAuth flow, session management, crypto helpers
- `src/github/` — GitHub API client
- `src/alerts/` — cron jobs and email alerting
- `src/*/store.ts` — D1 query layer (one per domain)
- `web/src/` — React/Vite SPA source
