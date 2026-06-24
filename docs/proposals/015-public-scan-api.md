# Plan 015 — Public, Token-Authenticated Scan API

**Status:** Spike / Design Proposal  
**Branch:** `advisor/015-spike-public-scan-api`  
**Author:** Advisor agent  
**Date:** 2026-06-24

---

## Background

The detection engine (`src/engine/evaluate.ts`) is already a pure, typed
contract. `evaluateRepo` and `evaluateAccount` accept plain snapshot objects
and return structured `RepoReport` / `AccountReport` values — no Workers APIs,
no side-effects. Only the cookie-session route layer (`src/routes/scan.ts`,
gated by `requireAuth` + `requireNotSuspended` + `rateLimit`) stands between
the engine and an external caller.

The README frames "vet a repo an AI agent suggested" as a primary use case.
Agents and CI pipelines cannot carry a browser session cookie; they need a
stable bearer token. This proposal answers how to expose the engine safely.

---

## 1. Auth Model

### Recommendation: per-user API keys, stored hashed, passed as `Authorization: Bearer`

**Key issuance.**  
Mint keys with the existing `randomToken(32)` from `src/auth/crypto.ts`
(already used for session IDs and unsubscribe tokens). A key looks like:
`rss_<48-char url-safe base64>`. The `rss_` prefix makes accidental leaks
machine-scannable (GitHub secret scanning, trufflehog, etc.).

**Storage.** Store only `sha256Hex(rawKey)` in D1, mirroring the existing
session-ID hashing pattern (see `src/auth/crypto.ts`, line 29). The raw key
exists in memory only at mint time and is shown to the user once.

**Proposed schema** (future migration `0003_api_keys.sql`):

```sql
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,   -- randomToken(12) — opaque record id
  login        TEXT NOT NULL,      -- owner (FK to users.login)
  key_hash     TEXT NOT NULL UNIQUE,
  label        TEXT,               -- user-supplied name ("CI", "my-agent")
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX idx_api_keys_login   ON api_keys (login);
CREATE INDEX idx_api_keys_hash    ON api_keys (key_hash);
```

One login may hold multiple keys (CI + personal agent + third-party). Revoke
by setting `revoked_at`; keep the row for audit purposes.

**Lookup cost.** One `SELECT WHERE key_hash = ?` per request — the index on
`key_hash` makes this a point lookup. Acceptable on D1 at low key volume;
revisit if key count grows past ~100k.

**Self-service UI surface** (deferred to the build plan):  
A `/settings/api-keys` page (or `/api/keys` JSON endpoints) lets users mint,
label, and revoke keys. Admins see all keys for a user in the admin user-detail
view. Key limit per user: start at 5 (configurable env var) to bound abuse.

### GitHub token for the actual API calls: reuse the key owner's stored OAuth token

**Recommendation: reuse the key owner's encrypted OAuth token** (retrieved
from the `sessions` table by login), **with an explicit documented caveat**.

When a key owner authenticates via OAuth, their GitHub access token is stored
AES-GCM encrypted in the `sessions` table (`token_enc`). At scan time the
`requireAuth` middleware decrypts it and constructs a `GitHubClient`. A key
lookup can do the same: find the user's most-recent active session, decrypt the
token, build a `GitHubClient`.

**Why this is the simplest path:**  
The caller does not need to supply a GitHub token. The scanning engine calls
only the public GitHub REST API for the *target* repo/account — not anything
about the key owner. The only reason an OAuth token is needed at all is that
authenticated requests have a 5,000 req/h quota instead of 60 req/h. The
token is not granting the caller access to the key owner's private data; it is
purely a quota-elevation credential for reading public GitHub resources.

**The security implication to document and enforce:**  
If the key owner's OAuth token is revoked (e.g. they deauthorize the app on
GitHub), scans via their API key will silently fall back to unauthenticated
requests (60 req/h) or fail. The `requireAuth` middleware already handles this
gracefully — a 401 from GitHub during a scan returns a `github_error` 502.

The deeper concern is: if Alice's key is stolen, an attacker can consume
Alice's GitHub quota on Alis's behalf. Mitigations: per-key rate limits
(Section 3), `last_used_at` logging, admin visibility on key velocity.

**Alternative (require the caller to supply their own GitHub token):**  
The caller passes `X-GitHub-Token: <ghp_...>` alongside their API key. This
eliminates the shared-quota problem and means a key leak cannot drain the
owner's GitHub budget. Trade-off: more friction for the caller (two credentials
to manage), and it punts "GitHub account not connected" errors to the API
consumer. Recommendation: start with reuse, add `X-GitHub-Token` override in a
follow-on once usage patterns are understood.

---

## 2. Scope and Response Contract

### Which scans to expose

| Endpoint | Expose? | Notes |
|---|---|---|
| `GET /api/scan?target=<owner/repo or owner>` | **Yes** | Bounded: one repo or one account. Primary agent use-case. |
| `GET /api/report` | **No** | "Scan my own account" — requires knowing the key owner's login. Unnecessary for external callers; leaks that the scanner is the key owner's own account. |
| `GET /api/clones` | **No (v1)** | The most expensive operation: GitHub code-search is the scarcest secondary-rate-limit resource (30 req/min shared across all users). Exposing this publicly risks burning the shared search quota. Add in v2 with tighter limits. |

Expose only `POST /v1/scan` (changing to POST makes intent explicit and
prevents browser pre-fetch):

```
POST /v1/scan
Authorization: Bearer rss_<key>
Content-Type: application/json

{ "target": "owner/repo" }
```

### Response contract — exact engine types to reuse

The engine already exports a complete type hierarchy in `src/engine/types.ts`.
The public API response is a strict subset:

**`POST /v1/scan` → `200 OK`:**

```typescript
// Imported from src/engine/types.ts — not redefined.
type ScanApiResponse =
  | { kind: 'repo';    report: RepoReport    }
  | { kind: 'account'; report: AccountReport; scanned: number; totalRepos: number };
```

This is the same shape already returned by `GET /api/scan` (defined in
`web/src/api.ts` as `ScanResponse`). The public API reuses the identical
serialization — no second schema to maintain.

Key engine types a caller must understand:

- `RepoReport` — `{ repo, findings: Finding[], score: number, band: RiskBand }`
- `AccountReport` — `{ account, findings, score, band, repoReports, summary }`
- `Finding` — `{ id, title, severity: Severity, detail, remediation?, evidence?, weight }`
- `RiskBand` — `'safe' | 'low' | 'elevated' | 'high' | 'critical'`
- `Severity` — `'critical' | 'high' | 'medium' | 'low' | 'info'`

The `score` field (0–100) is the machine-readable primary output. The `band`
field is the human bucket. For agent/CI use, `band === 'high' || band ===
'critical'` is the recommended block condition.

**Error responses** follow the existing error shape already used throughout
scan.ts:

```json
{ "error": "rate_limited", "message": "...", "retryAfterSec": 60 }
{ "error": "not_found",    "message": "..." }
{ "error": "bad_target",   "message": "..." }
{ "error": "unauthorized", "message": "..." }
```

---

## 3. Rate Limiting Per Key

### Recommendation: new tiers keyed by API key ID, not login

The existing `consumeRateLimits` in `src/ratelimit/store.ts` is parameterized
by a bucket string (`${tier.action}:${login}`). The only change needed is to
pass `apikey:${keyId}` instead of `login`. The tier logic, the `rate_events`
table, the `Retry-After` header behaviour — all reuse verbatim.

**Proposed tiers for API keys (conservative v1):**

```typescript
// In src/routes/rate-limit.ts — add alongside existing exports
export const API_KEY_BURST: RateTier = {
  action: 'apikey-scan',
  limit: 10,
  windowMs: 60_000,          // 10 scans/min (vs 20 for cookie sessions)
};
export const API_KEY_DAILY: RateTier = {
  action: 'apikey-scan-day',
  limit: 100,
  windowMs: 86_400_000,      // 100 scans/day (vs 300 for cookie sessions)
};
```

**Why tighter than cookie-session tiers?**  
Cookie sessions are tied to interactive users who are mostly rate-limited by
human speed. API keys are scripted, so the same burst headroom would be
exhausted in seconds. The 100/day cap is generous for CI while still bounding
the quota impact of a stolen key.

**The scarce resource is the shared GitHub search quota (for clones, excluded
in v1).** For repo/account scans, each scan fans out ~5–8 GitHub REST calls
against the key owner's 5,000 req/h budget. At 100/day a single key consumes
at most 800 GitHub API calls — well within budget.

**Admin exemption:** admins' API keys should also be exempt from rate limiting
(consistent with the existing `isAdminUser` check in `src/routes/rate-limit.ts`
line 17).

---

## 4. CSRF Relationship

### Recommendation: detect `Authorization` header presence and bypass CSRF on that branch only

The app currently sets a `Content-Security-Policy: connect-src 'self'` header
(`src/index.ts`, line 26), which provides a meaningful but not absolute CSRF
defence for browser requests. If a traditional CSRF token or `SameSite=Strict`
cookie check is added in the future, it must not apply to API-key-authenticated
requests.

**The rule:** CSRF protection (Origin check, `SameSite` cookie requirement,
double-submit token) applies if and only if the request is authenticated via
cookie session (ambient credential). Requests bearing `Authorization: Bearer
rss_...` carry an explicit credential and are inherently non-CSRF-vulnerable.

**Implementation pattern** for a new `requireApiKey` middleware:

```typescript
export async function requireApiKeyOrSession(
  c: AppCtx,
  next: Next,
): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer rss_')) {
    // Token path — no CSRF check; validate the key and proceed.
    return resolveApiKey(c, next, authHeader.slice(7));
  }
  // Cookie path — apply existing requireAuth (which already enforces the
  // session + SameSite cookie). Add any CSRF gate here, before calling next().
  return requireAuth(c, next);
}
```

This keeps the CSRF surface in one place: the cookie branch of this single
middleware. The key branch never touches the session or cookie.

**Concrete note on current state:** the app does not today have an explicit
CSRF token check beyond CSP + `SameSite` (the cookie is `HttpOnly; SameSite
= ...` — check `src/auth/session.ts` for the exact SameSite setting). When
that check is added, the `Authorization: Bearer` early-return above prevents it
from blocking API-key callers.

---

## 5. Abuse Surface

### What stops a key being a free GitHub-scanning proxy

**Five-layer defence:**

1. **Per-key quota** (Section 3 — `API_KEY_DAILY: 100`). A stolen key can
   exhaust at most 100 scans/day against the owner's GitHub quota. This is
   orders of magnitude below the level that would trigger GitHub's secondary
   rate limits on REST endpoints.

2. **Suspended-user check** (`requireNotSuspended`). The key lookup resolves
   the key owner's `UserRecord`. If `suspendedAt` is non-null, the scan is
   rejected with `403 suspended`. A compromised key from a suspended user is
   immediately inert. This reuses the existing middleware unchanged.

3. **`recordScan` logging** (`src/scans/store.ts`). Every successful scan
   writes a row to the `scans` table with `login`, `kind`, `target`, and
   `top_score`. Admin analytics already surface per-user velocity and
   `topScannedTargets`. API-key scans should be tagged with `kind = 'api'` (or
   `'api-repo'` / `'api-account'`) so admin can filter them distinctly. The
   `last_used_at` column on `api_keys` provides a secondary signal.

4. **Key count limit per user** (e.g. 5). Constrains blast radius if one user
   acts as a proxy farm.

5. **`target` validation via `parseTarget`** (already in `src/routes/scan.ts`
   line 156). The GitHub client only ever calls `api.github.com` with
   validated `owner` and `repo` path segments (see `src/github/client.ts`
   line 19 — `NAME_RE`). There is no SSRF surface.

**What is NOT mitigated here:**  
A legitimate key owner who has not been suspended can proxy scans for others
at 100/day. This is structurally no different from a signed-in user clicking
"scan" 100 times. The admin's `topScannedTargets` view makes industrialised
proxying visible; the resolution is manual suspension + key revocation.

---

## 6. Open Questions for the Maintainer

Before building Plan 016 (the actual feature), the maintainer must resolve:

**Q1 — GitHub token fallback strategy.** If the key owner has no active
session (token expired, app deauthorized), should the API: (a) fail with
`402 no_github_token` and require re-login, or (b) proceed unauthenticated
at 60 req/h? Option (b) silently degrades; option (a) breaks CI until the
owner re-authenticates. Recommendation: option (a), with a clear error code,
because degraded-quota scans may silently produce wrong results (GitHub 429
mid-scan → partial findings).

**Q2 — Token refresh / long-lived GitHub tokens.** GitHub OAuth tokens for
apps using the "Web Application Flow" do not currently expire unless the user
revokes them. If the app ever switches to GitHub Apps (which use short-lived
installation tokens), the "reuse stored token" model breaks. Note this
dependency now and revisit when/if GitHub Apps migration is considered.

**Q3 — Versioning and `/v1/` prefix.** The internal API lives under `/api/`.
Should the public API live at `/v1/` (separate prefix, explicitly versioned) or
under `/api/v1/`? The former is cleaner for external consumers (avoids
confusion with internal routes); the latter keeps routing in one place. Decide
before cut-over — the URL is a public contract.

**Q4 — `clones` endpoint timing.** The GitHub code-search secondary rate limit
(30 requests/minute across all authenticated calls for an OAuth app) is a
shared, per-app resource. Even if per-key limits are tight, a flood of API-key
clone scans from many users simultaneously could exhaust it. Decide: exclude
clones from v1 (recommended) or add a global token-bucket around `findClonesForRepos`.

**Q5 — Key visibility scope.** Should a user be able to see the full raw key
after creation (shown once, then only the hash is stored), or should re-display
be possible by re-generating? The "shown once" model is more secure but common
support friction. Standard practice (GitHub PATs, Stripe API keys) is
show-once; document this clearly in the UI.

**Q6 — Max keys per user.** The proposal says 5. Is that enough for the primary
agent/CI use case? A developer might have: local dev key, CI key, staging key,
production key, third-party integration key. Consider 10.

---

## Appendix: Prototype Viability Assessment

The plan asks whether a throwaway flag-gated prototype (key → engine wiring) is
safe to include.

**Assessment: SKIP.** The key→engine wiring requires at minimum:

1. A `resolveApiKey` function that reads `api_keys` from D1 (which does not yet
   exist — the table isn't in the schema).
2. A session-token retrieval by login (fetching from `sessions` table by login,
   not by session id — a query not currently written).
3. A new route mounted conditionally on a flag.

Step 1 requires the `api_keys` migration; step 2 is a new DB query that needs
to be carefully written (e.g., picking the most recent non-expired session when
multiple exist). Neither is a "trivial wiring" — both touch the trust boundary.
Adding them as throwaway code risks them being promoted to production
accidentally or creating a misleading impression of completeness.

The doc is the real deliverable. The build plan (Plan 016) should start clean
from this design.
