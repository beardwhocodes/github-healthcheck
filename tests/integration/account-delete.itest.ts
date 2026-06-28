// Integration test for full account deletion (DELETE /api/me). Drives a real
// request through the Worker (origin gate + requireAuth) against real miniflare
// D1, proving that every store's rows for the login are erased — including the
// encrypted OAuth token — and that the GitHub token-revoke call is attempted.
// A pure unit test can't cover the cross-store batch or the auth boundary.
import { env, fetchMock, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { encrypt, randomToken, sha256Hex } from '../../src/auth/crypto.js';

const DB = (env as unknown as { DB: D1Database }).DB;
const SESSION_SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
const GITHUB_CLIENT_ID = (env as unknown as { GITHUB_CLIENT_ID: string }).GITHUB_CLIENT_ID;

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
    for (const stmt of statements) {
      await DB.prepare(stmt).run();
    }
  }
}

function url(path: string): string {
  return `https://test.local${path}`;
}

// Seed one row in every table account deletion must clear, for `login`, and a
// session whose raw cookie id is returned for the authenticated request.
async function seedAccount(login: string): Promise<string> {
  const now = Date.now();
  const rawId = randomToken(32);
  const idHash = await sha256Hex(rawId);
  const tokenEnc = await encrypt('gho_realtoken', SESSION_SECRET);

  await DB.batch([
    DB.prepare(
      `INSERT INTO sessions (id, login, name, avatar_url, scopes, token_enc, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(idHash, login, login, 'https://avatar.example/x.png', 'read:user', tokenEnc, now + 3_600_000),
    DB.prepare(
      `INSERT INTO users (login, name, avatar_url, role, includes_private, scan_count, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, 'user', 0, 1, ?, ?)`,
    ).bind(login, login, 'https://avatar.example/x.png', now, now),
    DB.prepare(
      `INSERT INTO alert_subscriptions (login, email, token_enc, active, verified, created_at)
       VALUES (?, ?, ?, 1, 1, ?)`,
    ).bind(login, `${login}@example.com`, tokenEnc, now),
    DB.prepare(`INSERT INTO watched_repos (login, full_name) VALUES (?, ?)`).bind(login, `${login}/repo`),
    DB.prepare(
      `INSERT INTO known_clones (login, source_repo, suspect_repo, confidence, first_seen, notified)
       VALUES (?, ?, ?, 90, ?, 1)`,
    ).bind(login, `${login}/repo`, 'evil/clone', now),
    DB.prepare(
      `INSERT INTO scans (id, login, kind, target, top_score, created_at) VALUES (?, ?, 'self', NULL, 10, ?)`,
    ).bind(randomToken(12), login, now),
    DB.prepare(
      `INSERT INTO messages (id, login, email, subject, body, status, created_at)
       VALUES (?, ?, ?, 'hi', 'body', 'open', ?)`,
    ).bind(randomToken(12), login, `${login}@example.com`, now),
    DB.prepare(
      `INSERT INTO reported_repos (id, reporter_login, suspect_repo, status, created_at, updated_at)
       VALUES (?, ?, 'evil/clone', 'reported', ?, ?)`,
    ).bind(randomToken(12), login, now, now),
  ]);

  return rawId;
}

async function countFor(table: string, column: string, login: string): Promise<number> {
  const row = await DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
    .bind(login)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await applyMigrations();
});

afterEach(() => {
  fetchMock.deactivate();
});

describe('DELETE /api/me (account deletion)', () => {
  it('revokes the GitHub token and erases all of the user rows', async () => {
    const login = 'deluser';
    const rawId = await seedAccount(login);

    fetchMock.activate();
    fetchMock.disableNetConnect();
    // GitHub "Delete an app token" returns 204 on success.
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: `/applications/${GITHUB_CLIENT_ID}/token`, method: 'DELETE' })
      .reply(204, '');

    const res = await SELF.fetch(url('/api/me'), {
      method: 'DELETE',
      headers: { Cookie: `__Host-rs_session=${rawId}`, Origin: 'https://test.local' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Every store's rows for this login must be gone.
    expect(await countFor('sessions', 'login', login)).toBe(0);
    expect(await countFor('users', 'login', login)).toBe(0);
    expect(await countFor('alert_subscriptions', 'login', login)).toBe(0);
    expect(await countFor('watched_repos', 'login', login)).toBe(0);
    expect(await countFor('known_clones', 'login', login)).toBe(0);
    expect(await countFor('scans', 'login', login)).toBe(0);
    expect(await countFor('messages', 'login', login)).toBe(0);
    expect(await countFor('reported_repos', 'reporter_login', login)).toBe(0);

    // The session cookie must be cleared on the response.
    expect(res.headers.get('set-cookie') ?? '').toMatch(/rs_session=;|max-age=0/i);
  });

  it('still erases local data when GitHub revoke fails (best-effort)', async () => {
    const login = 'deluser2';
    const rawId = await seedAccount(login);

    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: `/applications/${GITHUB_CLIENT_ID}/token`, method: 'DELETE' })
      .reply(500, 'boom');

    const res = await SELF.fetch(url('/api/me'), {
      method: 'DELETE',
      headers: { Cookie: `__Host-rs_session=${rawId}`, Origin: 'https://test.local' },
    });

    expect(res.status).toBe(200);
    expect(await countFor('users', 'login', login)).toBe(0);
    expect(await countFor('alert_subscriptions', 'login', login)).toBe(0);
  });

  it('rejects an unauthenticated delete with 401', async () => {
    const res = await SELF.fetch(url('/api/me'), {
      method: 'DELETE',
      headers: { Origin: 'https://test.local' },
    });
    expect(res.status).toBe(401);
  });
});
