// Integration tests for the daily impersonation-scan cron orchestration.
// Covers the sharding/selection contract (only active + verified + non-suspended
// subscribers are scanned, ordered least-recently-scanned first) and the per-
// subscriber outcome handling: a clean run advances both the clean-run marker
// (last_run_at) and the sharding cursor (last_scanned_at); an ABORTED scan
// advances ONLY the cursor (the stale marker is how an abort is surfaced); a 401
// deactivates and zeroes the stored token. GitHub is mocked and `now` is passed
// explicitly, so the run is deterministic with no wall-clock dependency.
//
// The clone-baseline WRITE/dedupe contract (recordClones / getKnownSuspectRepos)
// is covered structurally in alerts.itest.ts; here we assert the cron READS that
// baseline on a clean scan and records nothing when no new clone is found.
import { env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env.js';
import { runImpersonationScan } from '../../src/alerts/cron.js';
import { getKnownSuspectRepos, listActiveSubscriptions } from '../../src/alerts/store.js';
import { encrypt } from '../../src/auth/crypto.js';

const appEnv = env as unknown as Env;
const DB = (env as unknown as { DB: D1Database }).DB;
const SESSION_SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

const migrationModules = import.meta.glob('../../migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

async function applyMigrations(): Promise<void> {
  for (const file of Object.keys(migrationModules).sort()) {
    const sql = migrationModules[file];
    if (!sql) continue;
    const statements = sql
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) await DB.prepare(stmt).run();
  }
}

const NOW = 1_700_000_000_000;
const JSON_HEADERS = { headers: { 'content-type': 'application/json' } };

interface SeedSubArgs {
  login: string;
  active?: number;
  verified?: number;
  lastRunAt?: number | null;
  lastScannedAt?: number | null;
  // When set, also create a users row carrying this suspended_at (suspends the sub).
  suspendedAt?: number;
}

async function seedSub(args: SeedSubArgs): Promise<void> {
  const tokenEnc = await encrypt('gho_crontoken', SESSION_SECRET);
  await DB.prepare(
    `INSERT INTO alert_subscriptions
       (login, email, token_enc, active, verified, verify_token, unsubscribe_token,
        verified_at, created_at, last_run_at, last_scanned_at, verify_expires_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      args.login,
      `${args.login}@example.com`,
      tokenEnc,
      args.active ?? 1,
      args.verified ?? 1,
      NOW,
      NOW,
      args.lastRunAt ?? null,
      args.lastScannedAt ?? null,
    )
    .run();

  if (args.suspendedAt !== undefined) {
    await DB.prepare(
      `INSERT INTO users (login, name, avatar_url, role, suspended_at, includes_private, scan_count, first_seen_at, last_seen_at)
       VALUES (?, ?, NULL, 'user', ?, 0, 0, ?, ?)`,
    )
      .bind(args.login, args.login, args.suspendedAt, NOW, NOW)
      .run();
  }
}

async function getSubRow(login: string): Promise<{
  active: number;
  token_enc: string;
  last_run_at: number | null;
  last_scanned_at: number | null;
}> {
  const row = await DB.prepare(
    `SELECT active, token_enc, last_run_at, last_scanned_at FROM alert_subscriptions WHERE login = ?`,
  )
    .bind(login)
    .first<{ active: number; token_enc: string; last_run_at: number | null; last_scanned_at: number | null }>();
  if (!row) throw new Error(`no subscription row for ${login}`);
  return row;
}

// Mock GitHub's /user token-validity probe with a single status.
function mockUserProbe(status: number, body = '{"login":"x"}'): void {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get('https://api.github.com')
    .intercept({ path: '/user', method: 'GET' })
    .reply(status, body, JSON_HEADERS);
}

beforeEach(async () => {
  await applyMigrations();
});

afterEach(() => {
  fetchMock.deactivate();
});

describe('listActiveSubscriptions (cron selection + sharding)', () => {
  it('returns only active + verified + non-suspended subscribers', async () => {
    await seedSub({ login: 'active1', lastScannedAt: null });
    await seedSub({ login: 'active2', lastScannedAt: NOW - 1_000 });
    await seedSub({ login: 'inactive', active: 0 });
    await seedSub({ login: 'unverified', verified: 0 });
    await seedSub({ login: 'suspended', suspendedAt: NOW - 5_000 });

    const subs = await listActiveSubscriptions(appEnv);
    const logins = new Set(subs.map((s) => s.login));
    expect(logins).toEqual(new Set(['active1', 'active2']));
  });

  it('orders by least-recently-scanned (NULL first) and honors the shard limit', async () => {
    await seedSub({ login: 'never', lastScannedAt: null });
    await seedSub({ login: 'oldest', lastScannedAt: NOW - 9_000 });
    await seedSub({ login: 'recent', lastScannedAt: NOW - 1_000 });

    const batch = await listActiveSubscriptions(appEnv, 2);
    expect(batch.map((s) => s.login)).toEqual(['never', 'oldest']);
  });
});

describe('runImpersonationScan (per-subscriber outcomes)', () => {
  it('advances BOTH markers on a clean run (no watched repos)', async () => {
    await seedSub({ login: 'clean', lastRunAt: null, lastScannedAt: null });
    mockUserProbe(200, '{"login":"clean"}');

    const result = await runImpersonationScan(appEnv, NOW);
    expect(result.scanned).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.deactivated).toBe(0);

    const row = await getSubRow('clean');
    expect(row.last_run_at).toBe(NOW);
    expect(row.last_scanned_at).toBe(NOW);
  });

  it('reads the clone baseline on a clean watched-repo run and records nothing new', async () => {
    await seedSub({ login: 'watcher', lastRunAt: null, lastScannedAt: null });
    await DB.prepare(`INSERT INTO watched_repos (login, full_name) VALUES (?, ?)`)
      .bind('watcher', 'watcher/myrepo')
      .run();

    fetchMock.activate();
    fetchMock.disableNetConnect();
    const gh = fetchMock.get('https://api.github.com');
    gh.intercept({ path: '/user', method: 'GET' }).reply(200, '{"login":"watcher"}', JSON_HEADERS);
    // No same-name candidates => no clones => nothing recorded.
    gh.intercept({ path: /^\/search\/repositories/, method: 'GET' }).reply(
      200,
      '{"items":[]}',
      JSON_HEADERS,
    );

    const result = await runImpersonationScan(appEnv, NOW);
    expect(result.scanned).toBe(1);

    expect((await getKnownSuspectRepos(appEnv, 'watcher')).size).toBe(0);
    const row = await getSubRow('watcher');
    expect(row.last_run_at).toBe(NOW);
  });

  it('advances ONLY the sharding cursor on an aborted scan, not the run marker', async () => {
    await seedSub({ login: 'aborter', lastRunAt: null, lastScannedAt: null });
    // A 403 with no Retry-After is a non-retryable probe failure => aborted
    // (no wall-clock retry delay; isRetryable() is false for a plain 403).
    mockUserProbe(403, '');

    const result = await runImpersonationScan(appEnv, NOW);
    expect(result.failed).toBe(1);
    expect(result.scanned).toBe(0);

    const row = await getSubRow('aborter');
    // The clean-run marker must stay stale — that is how an abort is surfaced.
    expect(row.last_run_at).toBeNull();
    // The cursor advances so a stuck subscriber can't starve the batch.
    expect(row.last_scanned_at).toBe(NOW);
  });

  it('deactivates and zeroes the token on a 401 (revoked grant)', async () => {
    await seedSub({ login: 'revoked', lastRunAt: null, lastScannedAt: null });
    mockUserProbe(401, '');

    const result = await runImpersonationScan(appEnv, NOW);
    expect(result.deactivated).toBe(1);
    expect(result.scanned).toBe(0);

    const row = await getSubRow('revoked');
    expect(row.active).toBe(0);
    expect(row.token_enc).toBe('');
  });
});
