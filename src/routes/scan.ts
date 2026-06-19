import { Hono } from 'hono';
import type { Context } from 'hono';

import { evaluateAccount, evaluateRepo } from '../engine/evaluate.js';
import type { Env } from '../env.js';
import { findClonesForRepos } from '../github/clone-detection.js';
import { GitHubApiError, isValidName } from '../github/client.js';
import { buildAccountSnapshot, buildRepoSnapshot, mapWithConcurrency } from '../github/snapshot.js';
import type { Vars } from './middleware.js';

export const scan = new Hono<{ Bindings: Env; Variables: Vars }>();

// Default caps keep a scan within the GitHub rate budget and snappy.
const DEFAULT_REPO_LIMIT = 30;
const MAX_REPO_LIMIT = 60;

// Who am I (drives the header / signed-in state in the UI).
scan.get('/me', (c) => {
  const s = c.get('session');
  return c.json({
    login: s.login,
    name: s.name,
    avatarUrl: s.avatarUrl,
    scopes: s.scopes,
    includesPrivate: s.scopes.split(/[ ,]+/).includes('repo'),
  });
});

// Full self-audit: the signed-in user's account + each of their repositories.
scan.get('/report', async (c) => {
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
    const snapshots = await mapWithConcurrency(selected, 4, (raw) =>
      buildRepoSnapshot(client, raw),
    );

    const report = evaluateAccount({ account, repos: snapshots, now });
    return c.json({ report, scanned: snapshots.length, totalRepos: rawRepos.length });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// Scan any repo (owner/name) or any account (owner). Accepts a github.com URL,
// "owner/repo", or "owner". Only api.github.com is ever contacted.
scan.get('/scan', async (c) => {
  const client = c.get('client');
  const now = Date.now();
  const target = parseTarget(c.req.query('target') ?? '');
  if (!target) {
    return c.json({ error: 'bad_target', message: 'Provide a GitHub URL, owner/repo, or username.' }, 400);
  }

  try {
    if (target.kind === 'repo') {
      const raw = await client.getRepo(target.owner, target.name);
      const snapshot = await buildRepoSnapshot(client, raw, { includeTree: true });
      const report = evaluateRepo(snapshot, { now });
      return c.json({ kind: 'repo', report });
    }

    const rawUser = await client.getUser(target.owner);
    const account = buildAccountSnapshot(rawUser, null); // 2FA unknowable for others
    const rawRepos = await client.listRepos({ login: target.owner, self: false });
    const selected = rawRepos.slice(0, DEFAULT_REPO_LIMIT);
    const snapshots = await mapWithConcurrency(selected, 4, (r) => buildRepoSnapshot(client, r));
    const report = evaluateAccount({ account, repos: snapshots, now });
    return c.json({ kind: 'account', report, scanned: snapshots.length, totalRepos: rawRepos.length });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// Detect clones/impersonations of the signed-in user's own repositories.
scan.get('/clones', async (c) => {
  const client = c.get('client');
  const session = c.get('session');
  const now = Date.now();
  // Cap the number of source repos we search for (search is the scarcest quota).
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
    if (err.status === 429) return c.json({ error: 'rate_limited', message: err.message }, 429);
    return c.json({ error: 'github_error', message: err.message }, 502);
  }
  return c.json({ error: 'scan_failed', message: 'The scan could not be completed.' }, 500);
}
