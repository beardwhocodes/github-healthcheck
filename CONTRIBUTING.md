# Contributing to GitHub Healthcheck

Thanks for your interest! This is a small, focused project — a Cloudflare Workers
+ Hono backend with a React/Vite SPA that scores GitHub accounts and repositories
against a known malware-clone campaign. Contributions that improve detection
accuracy, security, reliability, or docs are very welcome.

## Reporting issues

- **Bug or feature idea** → open an [issue](../../issues/new/choose).
- **Security vulnerability** → **do not** open a public issue. See
  [`SECURITY.md`](SECURITY.md) (private GitHub Security Advisory, or email).

## Getting set up

Prerequisites: **Node 22** and **pnpm** (the repo is pnpm-only — see
`packageManager` in `package.json`).

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in a GitHub OAuth App + SESSION_SECRET
pnpm db:init                     # create local D1 tables
pnpm dev                         # SPA on :5173, Worker API on :8787
```

See the [README](README.md#quickstart) for the full `.dev.vars` details.

## Before you open a PR

Run the full check suite locally and make sure each passes — CI runs the same
ones and a PR can't merge until `build-test` is green:

| Command | Checks |
| --- | --- |
| `pnpm typecheck` | TypeScript across `src/` and `web/` |
| `pnpm test` | Engine + unit tests |
| `pnpm test:integration` | Workers-pool + D1 integration tests |
| `pnpm lint` | Biome lint/format |
| `pnpm build:web` | SPA build + prerender |
| `pnpm exec wrangler deploy --dry-run` | Worker bundle compiles |

Add or update tests for any behavior change.

## Project conventions (please follow)

- **`src/engine/` must stay pure** — no `fetch`, no `env`/DB, no `Date.now()` /
  `Math.random()`, no I/O of any kind. It's unit-tested and a test enforces this.
  Detection vocabulary is data-driven in `src/engine/constants.ts` — extend the
  data rather than the rule logic where possible.
- **Migrations are append-only** — add a new numbered file in `migrations/NNNN_*.sql`;
  never edit an applied migration.
- **Store layer maps snake_case → camelCase by hand** and uses positional binds
  in a strict order (subquery binds, then `WHERE`, then `LIMIT`).
- **No new secrets in the repo.** Secrets are injected at runtime (`.dev.vars`
  locally, `wrangler secret` / Actions secrets in prod). Push protection is on.
- Match the surrounding style; comments explain **why**, not what.

## Pull request flow

1. Fork (or branch, if you have access) and make your change.
2. Run the checks above.
3. Open a PR against `master` with a clear description. Keep PRs focused.
4. CI must pass and review conversations must be resolved before merge.

Production deploys happen automatically from `master` via GitHub Actions —
never deploy from a local machine (`pnpm run deploy` is intentionally a no-op).

By contributing, you agree your contributions are licensed under the project's
[MIT License](LICENSE).
