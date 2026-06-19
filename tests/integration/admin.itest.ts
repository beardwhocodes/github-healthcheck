// Real-flow integration tests (miniflare D1 + the actual Worker). These prove
// the things the pure suite structurally cannot: that the authz/suspension
// middleware ACTUALLY blocks, and that the admin-preserving ON CONFLICT upsert
// behaves under real SQLite. No collaborator is mocked — the contract under test
// IS the wiring + the SQL.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env.js';
import { encrypt, randomToken } from '../../src/auth/crypto.js';
import { getUser, upsertUserOnLogin } from '../../src/users/store.js';
import { listActiveSubscriptions } from '../../src/alerts/store.js';

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

// Create a session row and return its cookie value.
async function seedSession(login: string): Promise<string> {
  const id = randomToken(32);
  const tokenEnc = await encrypt('gho_testtoken', SESSION_SECRET);
  const expiresAt = Date.now() + 60 * 60 * 1000;
  await DB.prepare(
    `INSERT INTO sessions (id, login, name, avatar_url, scopes, token_enc, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, login, login, 'https://avatar.example/x.png', 'read:user', tokenEnc, expiresAt)
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
