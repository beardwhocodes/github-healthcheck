import { Hono } from 'hono';
import type { Context } from 'hono';

import { evaluateAccount, evaluateRepo } from '../engine/evaluate.js';
import type { Env } from '../env.js';
import { findClonesForRepos } from '../github/clone-detection.js';
import { GitHubApiError, isValidName } from '../github/client.js';
import {
  buildAccountSnapshot,
  buildRepoSnapshotSafe,
  mapWithConcurrency,
} from '../github/snapshot.js';
import type { RepoSnapshot } from '../engine/types.js';
import { isAdminUser } from '../admin/policy.js';
import { parseAdminLogins } from '../admin/constants.js';
import type { ScanKind } from '../admin/constants.js';
import { recordScan } from '../scans/store.js';
import { deleteUserStatement } from '../users/store.js';
import { deleteAlertDataStatements } from '../alerts/store.js';
import { deleteMessagesStatement } from '../messages/store.js';
import { deleteReportsStatement } from '../reports/store.js';
import { deleteSessionsStatement, destroySession } from '../auth/session.js';
import { requireNotSuspended } from './middleware.js';
import type { Vars } from './middleware.js';
import { rateLimit, SCAN_BURST, SCAN_DAILY } from './rate-limit.js';

export const scan = new Hono<{ Bindings: Env; Variables: Vars }>();

// Fire-and-forget scan accounting: bumps the anonymous per-day/per-kind
// aggregate and the user's scan_count. No target/score/identity is logged (abuse
// velocity comes from rate_events). Never blocks or fails the response:
// scheduled on the execution context and swallows its own errors.
function logScan(c: Context<{ Bindings: Env; Variables: Vars }>, kind: ScanKind): void {
  const login = c.get('session').login;
  c.executionCtx.waitUntil(
    recordScan(c.env, { login, kind, now: Date.now() }).catch((err) =>
      console.log(`[scan] count failed for ${login}: ${String(err)}`),
    ),
  );
}

// Default caps keep a scan within the GitHub rate budget and snappy.
const DEFAULT_REPO_LIMIT = 30;
const MAX_REPO_LIMIT = 60;

// Who am I (drives the header / signed-in state in the UI).
scan.get('/me', (c) => {
  const s = c.get('session');
  const user = c.get('user');
  return c.json({
    login: s.login,
    name: s.name,
    avatarUrl: s.avatarUrl,
    scopes: s.scopes,
    includesPrivate: s.scopes.split(/[ ,]+/).includes('repo'),
    isAdmin: isAdminUser(user, parseAdminLogins(c.env.ADMIN_LOGINS)),
    suspended: user.suspendedAt != null,
    suspendedReason: user.suspendedReason,
  });
});

// Full account deletion / data erasure. Deliberately NOT gated by
// requireNotSuspended: a suspended user must still be able to erase their data.
// Idempotent and best-effort — safe to retry.
scan.delete('/me', async (c) => {
  const login = c.get('session').login;

  // 1) Best-effort: drop our app's OAuth authorization at GitHub so the token
  //    can never be reused, before we erase our encrypted copy of it. A failure
  //    here (GitHub down, network) must not block local erasure — the method
  //    swallows errors and reports success/failure, it never throws.
  const revoked = await c
    .get('client')
    .revokeOAuthToken(c.env.GITHUB_CLIENT_ID, c.env.GITHUB_CLIENT_SECRET);
  if (!revoked) console.log(`[delete] GitHub token revoke not confirmed for ${login}`);

  // 2) Hard-delete every row tied to this login in one atomic batch. This wipes
  //    the encrypted token (sessions + alert_subscriptions) along with all user
  //    data. Idempotent: a retry after the rows are gone is a clean no-op.
  // No scans-table deletion: scan activity is an identity-free aggregate
  // (scan_daily) with no per-user rows, so there is nothing to erase there.
  await c.env.DB.batch([
    deleteSessionsStatement(c.env, login),
    ...deleteAlertDataStatements(c.env, login),
    deleteMessagesStatement(c.env, login),
    deleteReportsStatement(c.env, login),
    deleteUserStatement(c.env, login),
  ]);

  // 3) Clear the session cookie (its row is already gone from the batch above).
  await destroySession(c);

  return c.json({ ok: true });
});

// Full self-audit: the signed-in user's account + each of their repositories.
// POST, not GET: it bumps scan counters (logScan), so it is state-changing and
// must sit behind the CSRF/origin gate — a victim clicking a crafted link must
// not be able to trigger (and meter) a self-audit on their behalf.
scan.post('/report', requireNotSuspended, rateLimit(SCAN_BURST, SCAN_DAILY), async (c) => {
  const client = c.get('client');
  const session = c.get('session');
  const limit = clampLimit(c.req.query('limit'));
  const now = Date.now();

  try {
    const rawUser = await client.getAuthenticatedUser();
    const account = buildAccountSnapshot(
      rawUser,
      typeof rawUser.two_factor_authentication === 'boolean'
        ? rawUser.two_factor_authentication
        : null,
    );

    const rawRepos = await client.listRepos({ login: session.login, self: true });
    const selected = rawRepos.slice(0, limit);
    const snapshotsRaw = await mapWithConcurrency(selected, 4, (raw) =>
      buildRepoSnapshotSafe(client, raw),
    );
    const snapshots = snapshotsRaw.filter((s): s is RepoSnapshot => s !== null);

    const report = evaluateAccount({ account, repos: snapshots, now });
    logScan(c, 'self');
    return c.json({ report, scanned: snapshots.length, totalRepos: rawRepos.length });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// Scan any repo (owner/name) or any account (owner). Accepts a github.com URL,
// "owner/repo", or "owner". Only api.github.com is ever contacted. POST (not GET)
// because it triggers work and a scan-counter write: a GET would let a
// SameSite=Lax link-click run a scan as the victim. `target` stays a query param.
scan.post('/scan', requireNotSuspended, rateLimit(SCAN_BURST, SCAN_DAILY), async (c) => {
  const client = c.get('client');
  const now = Date.now();
  const target = parseTarget(c.req.query('target') ?? '');
  if (!target) {
    return c.json({ error: 'bad_target', message: 'Provide a GitHub URL, owner/repo, or username.' }, 400);
  }

  try {
    if (target.kind === 'repo') {
      const raw = await client.getRepo(target.owner, target.name);
      const snapshot = await buildRepoSnapshotSafe(client, raw, { includeTree: true });
      if (!snapshot) {
        return c.json({ error: 'scan_failed', message: 'The scan could not be completed.' }, 500);
      }
      const report = evaluateRepo(snapshot, { now });
      logScan(c, 'repo');
      return c.json({ kind: 'repo', report });
    }

    const rawUser = await client.getUser(target.owner);
    const account = buildAccountSnapshot(rawUser, null); // 2FA unknowable for others
    const rawRepos = await client.listRepos({ login: target.owner, self: false });
    const selected = rawRepos.slice(0, DEFAULT_REPO_LIMIT);
    const snapshotsRaw = await mapWithConcurrency(selected, 4, (r) =>
      buildRepoSnapshotSafe(client, r),
    );
    const snapshots = snapshotsRaw.filter((s): s is RepoSnapshot => s !== null);
    const report = evaluateAccount({ account, repos: snapshots, now });
    logScan(c, 'account');
    return c.json({ kind: 'account', report, scanned: snapshots.length, totalRepos: rawRepos.length });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// Detect clones/impersonations of the signed-in user's own repositories. POST
// (not GET) because it triggers heavy work and a scan-counter write: a GET would
// let a SameSite=Lax link-click run a clone scan as the victim.
scan.post('/clones', requireNotSuspended, rateLimit(SCAN_BURST, SCAN_DAILY), async (c) => {
  const client = c.get('client');
  const session = c.get('session');
  const now = Date.now();
  // Cap the number of source repos we search for (search is the scarcest quota).
  // Subrequest-budget invariant: each source costs 1 search + up to
  // maxCandidates (8) candidate snapshots, and each candidate snapshot with
  // includeTree fans out to 6 GitHub subrequests (readme, commits, contributors,
  // releases, commit-files, tree). Worst case ≈ maxSources(15) × (1 + 8×6) = 735
  // subrequests, which (plus the initial listRepos) must stay under the Worker's
  // 1000-subrequest-per-invocation limit. Do not raise these caps blindly.
  const maxSources = Math.min(Number(c.req.query('maxSources') ?? 10) || 10, 15);

  try {
    const rawRepos = await client.listRepos({ login: session.login, self: true });
    const sources = rawRepos
      .filter((r) => !r.fork && !r.private)
      .map((r) => ({
        owner: String((r.owner as Record<string, unknown>)?.login ?? session.login),
        fullName: String(r.full_name ?? ''),
        description: (r.description as string | null) ?? null,
        stargazers: Number(r.stargazers_count ?? 0),
      }))
      .sort((a, b) => b.stargazers - a.stargazers)
      .slice(0, maxSources);

    const matches = await findClonesForRepos(client, sources, { now });
    logScan(c, 'clones');
    return c.json({
      sourcesScanned: sources.length,
      sources: sources.map((s) => s.fullName),
      matches,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

function clampLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REPO_LIMIT;
  return Math.min(Math.floor(n), MAX_REPO_LIMIT);
}

type Target = { kind: 'repo'; owner: string; name: string } | { kind: 'account'; owner: string };

export function parseTarget(input: string): Target | null {
  let s = input.trim();
  if (!s) return null;
  // Strip a github.com URL down to its path.
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, '');
  s = s.replace(/^github\.com\//i, '');
  s = s.replace(/\.git$/i, '').replace(/\/+$/g, '');
  const parts = s.split('/').filter(Boolean);

  if (parts.length === 1 && parts[0] && isValidName(parts[0])) {
    return { kind: 'account', owner: parts[0] };
  }
  if (parts.length >= 2 && parts[0] && parts[1] && isValidName(parts[0]) && isValidName(parts[1])) {
    return { kind: 'repo', owner: parts[0], name: parts[1] };
  }
  return null;
}

function errorResponse(c: Context<{ Bindings: Env; Variables: Vars }>, err: unknown): Response {
  if (err instanceof GitHubApiError) {
    if (err.status === 404) return c.json({ error: 'not_found', message: 'That repository or account was not found (or is private).' }, 404);
    if (err.status === 429) return c.json({ error: 'rate_limited', message: 'GitHub rate limit reached — please try again shortly.' }, 429);
    // Don't reflect the internal API path/message back to the client.
    return c.json({ error: 'github_error', message: 'GitHub could not complete that request.' }, 502);
  }
  return c.json({ error: 'scan_failed', message: 'The scan could not be completed.' }, 500);
}
