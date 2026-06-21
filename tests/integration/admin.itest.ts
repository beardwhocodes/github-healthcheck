// Real-flow integration tests (miniflare D1 + the actual Worker). These prove
// the things the pure suite structurally cannot: that the authz/suspension
// middleware ACTUALLY blocks, and that the admin-preserving ON CONFLICT upsert
// behaves under real SQLite. No collaborator is mocked — the contract under test
// IS the wiring + the SQL.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env.js';
import { encrypt, randomToken, sha256Hex } from '../../src/auth/crypto.js';
import { getUser, upsertUserOnLogin } from '../../src/users/store.js';
import { listActiveSubscriptions } from '../../src/alerts/store.js';
import { scansPerDay } from '../../src/scans/store.js';

const DB = (env as unknown as { DB: D1Database }).DB;
const SESSION_SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
const appEnv = env as unknown as Env;

// The real migration SQL, applied in filename order — exactly what
// `wrangler d1 migrations apply` runs — so the tests exercise the true schema.
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
      .replace(/--[^\n]*/g, '') // strip comments (defensive; baseline has none with ';')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await DB.prepare(stmt).run();
    }
  }
}

async function seedUser(args: {
  login: string;
  role?: 'user' | 'admin';
  suspendedAt?: number | null;
  reason?: string | null;
}): Promise<void> {
  const now = Date.now();
  await DB.prepare(
    `INSERT OR REPLACE INTO users
       (login, name, avatar_url, role, suspended_at, suspended_reason, suspended_by, includes_private, scan_count, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
  )
    .bind(
      args.login,
      args.login,
      'https://avatar.example/x.png',
      args.role ?? 'user',
      args.suspendedAt ?? null,
      args.reason ?? null,
      args.suspendedAt ? 'copyjosh' : null,
      now,
      now,
    )
    .run();
}

// Create a session row and return its cookie value. The row stores the HASH of
// the id (matching createSession); the raw id is what goes in the cookie.
async function seedSession(login: string): Promise<string> {
  const id = randomToken(32);
  const idHash = await sha256Hex(id);
  const tokenEnc = await encrypt('gho_testtoken', SESSION_SECRET);
  const expiresAt = Date.now() + 60 * 60 * 1000;
  await DB.prepare(
    `INSERT INTO sessions (id, login, name, avatar_url, scopes, token_enc, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(idHash, login, login, 'https://avatar.example/x.png', 'read:user', tokenEnc, expiresAt)
    .run();
  return id;
}

function as(cookie: string): RequestInit {
  return { headers: { Cookie: `rs_session=${cookie}` } };
}

function url(path: string): string {
  return `https://test.local${path}`;
}

beforeEach(async () => {
  await applyMigrations();
});

describe('authentication gate', () => {
  it('rejects anonymous requests to /api/me with 401', async () => {
    const res = await SELF.fetch(url('/api/me'));
    expect(res.status).toBe(401);
  });

  it('rejects a request bearing an unknown session cookie', async () => {
    const res = await SELF.fetch(url('/api/me'), as('does-not-exist'));
    expect(res.status).toBe(401);
  });
});

describe('admin authorization boundary', () => {
  it('returns 404 (not 403) to a non-admin hitting /api/admin/stats', async () => {
    await seedUser({ login: 'mallory', role: 'user' });
    const cookie = await seedSession('mallory');
    const res = await SELF.fetch(url('/api/admin/stats'), as(cookie));
    expect(res.status).toBe(404);
  });

  it('lets a stored admin reach /api/admin/stats', async () => {
    await seedUser({ login: 'jane', role: 'admin' });
    const cookie = await seedSession('jane');
    const res = await SELF.fetch(url('/api/admin/stats'), as(cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { total: number } };
    expect(typeof body.users.total).toBe('number');
  });

  it('treats the bootstrap admin as admin even when the row says role=user', async () => {
    // The DB row is deliberately wrong; resolveRole must override it.
    await seedUser({ login: 'copyjosh', role: 'user' });
    const cookie = await seedSession('copyjosh');
    const res = await SELF.fetch(url('/api/admin/stats'), as(cookie));
    expect(res.status).toBe(200);
  });

  it('reflects isAdmin in /api/me for admin vs non-admin', async () => {
    await seedUser({ login: 'copyjosh', role: 'user' });
    await seedUser({ login: 'mallory', role: 'user' });
    const adminMe = await SELF.fetch(url('/api/me'), as(await seedSession('copyjosh')));
    const userMe = await SELF.fetch(url('/api/me'), as(await seedSession('mallory')));
    expect(((await adminMe.json()) as { isAdmin: boolean }).isAdmin).toBe(true);
    expect(((await userMe.json()) as { isAdmin: boolean }).isAdmin).toBe(false);
  });
});

describe('suspension enforcement', () => {
  it('blocks scan actions for a suspended user but still serves /me', async () => {
    await seedUser({ login: 'bob', role: 'user', suspendedAt: Date.now(), reason: 'Excess scans' });
    const cookie = await seedSession('bob');

    const report = await SELF.fetch(url('/api/report'), as(cookie));
    expect(report.status).toBe(403);

    const me = await SELF.fetch(url('/api/me'), as(cookie));
    expect(me.status).toBe(200);
    const body = (await me.json()) as { suspended: boolean; suspendedReason: string | null };
    expect(body.suspended).toBe(true);
    expect(body.suspendedReason).toBe('Excess scans');
  });

  it('blocks the heavy POST /api/alerts path for a suspended user', async () => {
    await seedUser({ login: 'bob', role: 'user', suspendedAt: Date.now() });
    const cookie = await seedSession('bob');
    const res = await SELF.fetch(url('/api/alerts'), {
      method: 'POST',
      headers: { Cookie: `rs_session=${cookie}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('admin actions honour the policy guards (real getUser + real policy)', () => {
  async function adminCookie(): Promise<string> {
    await seedUser({ login: 'copyjosh', role: 'admin' });
    return seedSession('copyjosh');
  }

  function post(path: string, cookie: string, body: unknown): Promise<Response> {
    return SELF.fetch(url(path), {
      method: 'POST',
      headers: { Cookie: `rs_session=${cookie}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('refuses to suspend yourself', async () => {
    const cookie = await adminCookie();
    const res = await post('/api/admin/users/copyjosh/suspend', cookie, { reason: 'x' });
    expect(res.status).toBe(403);
  });

  it('refuses to suspend another admin', async () => {
    const cookie = await adminCookie();
    await seedUser({ login: 'jane', role: 'admin' });
    const res = await post('/api/admin/users/jane/suspend', cookie, { reason: 'x' });
    expect(res.status).toBe(403);
  });

  it('suspends a normal user and the suspension is then visible to them', async () => {
    const cookie = await adminCookie();
    await seedUser({ login: 'bob', role: 'user' });
    const bobCookie = await seedSession('bob');

    const suspend = await post('/api/admin/users/bob/suspend', cookie, { reason: 'Abuse' });
    expect(suspend.status).toBe(200);

    const bobReport = await SELF.fetch(url('/api/report'), as(bobCookie));
    expect(bobReport.status).toBe(403);
  });
});

describe('upsertUserOnLogin preserves admin state (real SQLite ON CONFLICT)', () => {
  it('never downgrades a runtime-promoted admin on a normal re-login', async () => {
    await seedUser({ login: 'jane', role: 'admin' });
    await upsertUserOnLogin(appEnv, {
      login: 'jane',
      name: 'Jane',
      avatarUrl: 'https://a/x.png',
      includesPrivate: false,
      now: Date.now(),
    });
    expect((await getUser(appEnv, 'jane'))?.role).toBe('admin');
  });

  it('re-promotes the bootstrap admin even if the stored row says user', async () => {
    await seedUser({ login: 'copyjosh', role: 'user' });
    await upsertUserOnLogin(appEnv, {
      login: 'copyjosh',
      name: 'Josh',
      avatarUrl: 'https://a/x.png',
      includesPrivate: true,
      now: Date.now(),
    });
    expect((await getUser(appEnv, 'copyjosh'))?.role).toBe('admin');
  });
});

describe('scan log audit endpoint', () => {
  async function seedScan(args: {
    login: string;
    kind: string;
    target: string | null;
    topScore: number | null;
    createdAt: number;
  }): Promise<void> {
    await DB.prepare(
      `INSERT INTO scans (id, login, kind, target, top_score, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(randomToken(8), args.login, args.kind, args.target, args.topScore, args.createdAt)
      .run();
  }

  it('returns 404 to a non-admin and the feed to an admin', async () => {
    await seedUser({ login: 'mallory', role: 'user' });
    await seedUser({ login: 'copyjosh', role: 'admin' });
    await seedScan({ login: 'mallory', kind: 'repo', target: 'evil/clone', topScore: 88, createdAt: Date.now() });

    const denied = await SELF.fetch(url('/api/admin/scans'), as(await seedSession('mallory')));
    expect(denied.status).toBe(404);

    const ok = await SELF.fetch(url('/api/admin/scans'), as(await seedSession('copyjosh')));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { scans: { login: string; kind: string; target: string | null }[] };
    expect(body.scans.length).toBe(1);
    expect(body.scans[0]).toMatchObject({ login: 'mallory', kind: 'repo', target: 'evil/clone' });
  });

  it('filters by kind', async () => {
    await seedUser({ login: 'copyjosh', role: 'admin' });
    const now = Date.now();
    await seedScan({ login: 'a', kind: 'repo', target: 'x/y', topScore: 10, createdAt: now });
    await seedScan({ login: 'a', kind: 'self', target: null, topScore: 5, createdAt: now });

    const res = await SELF.fetch(url('/api/admin/scans?kind=self'), as(await seedSession('copyjosh')));
    const body = (await res.json()) as { scans: { kind: string }[] };
    expect(body.scans.every((s) => s.kind === 'self')).toBe(true);
    expect(body.scans.length).toBe(1);
  });

  it('aggregates most-scanned distinct targets (excluding null-target self/clone scans)', async () => {
    await seedUser({ login: 'copyjosh', role: 'admin' });
    const now = Date.now();
    // evil/clone scanned by two different users (3 total); good/repo once; a self-audit (no target).
    await seedScan({ login: 'a', kind: 'repo', target: 'evil/clone', topScore: 90, createdAt: now - 200 });
    await seedScan({ login: 'a', kind: 'repo', target: 'evil/clone', topScore: 90, createdAt: now - 100 });
    await seedScan({ login: 'b', kind: 'repo', target: 'evil/clone', topScore: 90, createdAt: now });
    await seedScan({ login: 'a', kind: 'repo', target: 'good/repo', topScore: 5, createdAt: now - 50 });
    await seedScan({ login: 'a', kind: 'self', target: null, topScore: 0, createdAt: now });

    const res = await SELF.fetch(url('/api/admin/scans/top'), as(await seedSession('copyjosh')));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      targets: { target: string; kind: string; scans: number; scanners: number }[];
    };
    // Two distinct targets; the null-target self-audit is excluded.
    expect(body.targets.length).toBe(2);
    // Busiest first: evil/clone (3 scans, 2 distinct users) ahead of good/repo.
    expect(body.targets[0]).toMatchObject({ target: 'evil/clone', kind: 'repo', scans: 3, scanners: 2 });
    expect(body.targets[1]).toMatchObject({ target: 'good/repo', scans: 1, scanners: 1 });
  });

  it('returns 404 to a non-admin for the most-scanned view', async () => {
    await seedUser({ login: 'mallory', role: 'user' });
    const res = await SELF.fetch(url('/api/admin/scans/top'), as(await seedSession('mallory')));
    expect(res.status).toBe(404);
  });
});

describe('scansPerDay buckets by the viewer timezone (real SQLite date shift)', () => {
  async function seedScanAt(createdAt: number): Promise<void> {
    await DB.prepare(
      `INSERT INTO scans (id, login, kind, target, top_score, created_at) VALUES (?, 'u', 'self', NULL, NULL, ?)`,
    )
      .bind(randomToken(8), createdAt)
      .run();
  }

  it('shifts a 02:00 UTC scan back to the previous day for a US-Eastern viewer', async () => {
    const at = Date.parse('2026-06-20T02:00:00Z');
    const since = Date.parse('2026-06-01T00:00:00Z');
    await seedScanAt(at);

    const utc = await scansPerDay(appEnv, since, 0);
    expect(utc).toEqual([{ day: '2026-06-20', count: 1 }]);

    const eastern = await scansPerDay(appEnv, since, 300); // UTC-5 → 21:00 on the 19th
    expect(eastern).toEqual([{ day: '2026-06-19', count: 1 }]);
  });

  it('shifts a 23:00 UTC scan forward a day for an eastern (Cairo) viewer', async () => {
    const at = Date.parse('2026-06-19T23:00:00Z');
    const since = Date.parse('2026-06-01T00:00:00Z');
    await seedScanAt(at);

    const cairo = await scansPerDay(appEnv, since, -120); // UTC+2 → 01:00 on the 20th
    expect(cairo).toEqual([{ day: '2026-06-20', count: 1 }]);
  });
});

describe('the cron never scans a suspended subscriber', () => {
  async function seedSubscription(login: string): Promise<void> {
    await DB.prepare(
      `INSERT INTO alert_subscriptions
         (login, email, token_enc, active, verified, created_at)
       VALUES (?, ?, ?, 1, 1, ?)`,
    )
      .bind(login, `${login}@example.com`, 'enc', Date.now())
      .run();
  }

  it('excludes suspended logins from listActiveSubscriptions', async () => {
    await seedUser({ login: 'active-sub', role: 'user' });
    await seedUser({ login: 'suspended-sub', role: 'user', suspendedAt: Date.now() });
    await seedSubscription('active-sub');
    await seedSubscription('suspended-sub');

    const active = await listActiveSubscriptions(appEnv);
    const logins = active.map((s) => s.login);
    expect(logins).toContain('active-sub');
    expect(logins).not.toContain('suspended-sub');
  });
});
