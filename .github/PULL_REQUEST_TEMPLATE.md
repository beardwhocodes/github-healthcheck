<!-- Thanks for contributing! Keep PRs focused. See CONTRIBUTING.md. -->

## What & why

<!-- What does this change, and why? Link any related issue (e.g. "Closes #123"). -->

## AI assistance disclosure (required)

<!-- Keep this section. Undisclosed AI-generated contributions are not accepted. -->

- [ ] No AI tools were used for this contribution
- [ ] AI tools assisted with this contribution — what, and how I verified it:

## Checklist

- [ ] Ran the full suite locally and it passes: `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm lint`, `pnpm build:web`, `pnpm exec wrangler deploy --dry-run`
- [ ] Added/updated tests for any behavior change
- [ ] `src/engine/` stays pure (no I/O); migrations are append-only (new numbered file)
- [ ] No secrets committed
- [ ] Docs updated if behavior/usage changed
