# 🛡️ RepoSentry

**Sign in with GitHub and get a security report for your account and your repositories** —
purpose-built to detect the malware-distribution clone campaign documented by
[orchidfiles](https://orchidfiles.com/github-repositories-distributing-malware/) and the
[r/github warning](https://www.reddit.com/r/github/comments/1isxhas/) that *new repositories are
being cloned and weaponized*.

It does four things:

1. **Self-audit** — scores every one of your repositories against the campaign's indicators.
2. **Clone / impersonation detection** — searches GitHub for malicious copies of *your* repos.
3. **Account trust score** — a 0–100 risk grade for the whole account (age, 2FA, clustered activity).
4. **Ongoing alerts** — a daily background scan emails you when a *new* clone of your work appears.

You can also **vet any repo or account** before trusting it — handy for repos surfaced by search or
suggested by an AI coding agent (a primary target of this campaign).

---

## The threat, in one paragraph

Attackers clone a real, popular repository *verbatim* — full commit history, contributor list and
README — under a throwaway account (not a GitHub fork, so it reads as original). They change exactly
one thing: the README gets a single `Update README.md` commit adding a download link to a
password-protected ZIP. That ZIP contains a LuaJIT loader (`loader.exe`/`unit.exe`/`boot.exe`/
`lua51.dll` + a `.cmd` launcher) that pulls SmartLoader → StealC. The download link scans clean on
VirusTotal (only the extracted ZIP trips antivirus). ~10,000 such repos sat undetected for over a
year. RepoSentry encodes the exact tells the researcher used to find them.

## Detection methodology

Heuristics are adapted from the disclosure and the author's open-source CLI,
[`git-malware-finder`](https://github.com/orchidfiles/git-malware-finder). The engine
(`src/engine/`) is pure and fully unit-tested. Per repository it checks:

| Signal | Why it matters |
| --- | --- |
| README references a binary/archive (`.zip`, `.exe`, `.dll`, …) | The only payload a weaponized clone adds. |
| Download **badges** (shields.io) → archive | Real docs replaced with download buttons funneling to one ZIP. |
| **Password-protected** archive language | Deliberate AV/VirusTotal evasion. |
| URL shortener / anon file host (`bit.ly`, `mega.nz`, `t.me`…) | Hides and lets attackers rotate the payload URL. |
| "free / cracked / full version" lures next to a binary | Social-engineering hook. |
| **Latest commit changed only the README** | The single clearest tell of a weaponized clone. |
| Trivial `Update README.md` commit message | Every malicious clone shared this. |
| Dormant code, suddenly-bumped README | A long gap then a lone README change re-activates a clone. |
| Many inherited contributors, one recent README editor | History inherited from the clone, not earned. |
| Release asset named `loader.exe`/`lua51.dll`/`*.cmd` | The campaign's rotating payloads. |
| Loader / launcher / `.cso` committed in the tree | The exact ZIP file set, in the repo. |
| Archive buried deep in the tree | Payload disguised as a release artifact. |

Account-level: brand-new account, 2FA disabled (self only), repos created in a burst, multiple
archive-pushing READMEs, many repos with near-zero social footprint. Findings combine into a
diminishing-returns 0–100 score and a band (`safe → low → elevated → high → critical`).

> RepoSentry only ever calls `api.github.com`. It analyzes README/link **text** — it never downloads
> or executes any archive, and never fetches a user-supplied URL (no SSRF surface).

---

## Architecture

TypeScript end-to-end on Cloudflare — one platform for auth, data, scheduling, and email:

```
React + Vite SPA  ──>  Cloudflare Worker (Hono)  ──>  GitHub REST/GraphQL
   web/                src/                            api.github.com
                       ├─ engine/   pure detection rules + scoring (unit-tested)
                       ├─ github/   API client, snapshots, clone detection
                       ├─ auth/     GitHub OAuth, AES-GCM-encrypted sessions
                       ├─ routes/   /api/me /report /scan /clones /alerts
                       └─ alerts/   D1 store, email, daily cron re-scan
                              │
                       D1 (SQLite)  +  Cron Trigger (daily)  +  Email (Resend)
```

- **Sessions** are server-side: the GitHub token is AES-GCM encrypted at rest in D1; the browser
  cookie holds only an opaque, high-entropy id (httpOnly, Secure, SameSite=Lax).
- **OAuth** requests least privilege: `read:user` for public scans, `repo` only if the user opts into
  private repos. CSRF `state` is HMAC-signed.
- **Alerts** store an encrypted long-lived token so the daily Cron Trigger can re-search on the
  user's behalf, diff against a baseline of known clones, and email only the *new* ones.

---

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars     # then fill in the values below
npm run db:init                    # create local D1 tables
npm run dev                        # SPA on :5173, Worker API on :8787 (proxied)
```

Open <http://localhost:5173>.

**`.dev.vars`** (gitignored) needs:

- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — from a GitHub OAuth App
  ([create one](https://github.com/settings/developers)) with:
  - Homepage URL: `http://localhost:8787`
  - Authorization callback URL: `http://localhost:8787/auth/callback`
- `SESSION_SECRET` — `openssl rand -hex 32`
- `RESEND_API_KEY` — optional; without it, alert emails are logged instead of sent.

> In dev the SPA is served by Vite on :5173 and proxies `/api` + `/auth` to wrangler on :8787, so the
> OAuth callback URL must point at `:8787`.

### Useful scripts

| Script | Does |
| --- | --- |
| `npm run dev` | Run SPA + Worker together |
| `npm test` | Run the detection-engine unit tests |
| `npm run typecheck` | Typecheck Worker + SPA |
| `npm run build:web` | Build the SPA into `web/dist` |
| `npm run db:init` | Apply the D1 schema locally |

---

## Deployment (CI only)

**Production deploys run in GitHub Actions on every push to `master`** — never from a developer's
machine (`npm run deploy` is intentionally a no-op). See `.github/workflows/deploy.yml`: it
typechecks, tests, builds the SPA, dry-run-bundles the Worker, applies the (idempotent) D1 schema,
and deploys.

### One-time setup

1. **Create the Cloudflare resources** (once, by an admin):
   ```bash
   npx wrangler d1 create reposentry-db   # paste the id into wrangler.jsonc → d1_databases[0].database_id
   ```
2. **Set production config in `wrangler.jsonc`** `vars`: `APP_URL` (your domain), `GITHUB_CLIENT_ID`,
   `ALERT_FROM_EMAIL`. Create a **second** GitHub OAuth App for production with the callback URL
   `https://<your-domain>/auth/callback`.
3. **Set Worker secrets** (persist across deploys — set once):
   ```bash
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put RESEND_API_KEY      # optional
   ```
4. **Add repo secrets** to the private GitHub repo (Settings → Secrets and variables → Actions):
   `CLOUDFLARE_API_TOKEN` (Workers + D1 edit), `CLOUDFLARE_ACCOUNT_ID`.
5. **Flip the deploy switch**: add the repo **variable** `DEPLOY_ENABLED=true`. The deploy job is
   gated on it, so pushes stay green (build + test only) until your Cloudflare setup is ready.

Then push to `master` and the pipeline ships it. Pushes before step 5 still run typecheck/test/build.

---

## Roadmap / notes

- Scans are capped (default 30 repos per account, top-15 most-starred for clone search) to stay within
  GitHub's rate budget; caps are configurable via query params and `src/engine/constants.ts`.
- Worker integration tests (`@cloudflare/vitest-pool-workers`) and richer clone-confidence tuning are
  natural next steps.
- Heuristics are data-driven (`src/engine/constants.ts`) — extend the vocabulary as the campaign
  evolves without touching rule logic.
