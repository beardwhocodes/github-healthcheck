// Integration tests for session lifecycle and OAuth state-check branches.
// These prove security-critical paths that pure unit tests cannot: that
// expired sessions are truly rejected + row-deleted, that sweepExpiredSessions
// purges only expired rows, and that the three CSRF-guard branches in
// /auth/callback redirect with the correct error parameters before any outbound
// GitHub call is made.
import { env, fetchMock, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env.js';
import { encrypt, randomToken, sha256Hex, sign } from '../../src/auth/crypto.js';
import { sweepExpiredSessions } from '../../src/auth/session.js';

const DB = (env as unknown as { DB: D1Database }).DB;
const SESSION_SECRET = (
  env as unknown as { SESSION_SECRET: string }
).SESSION_SECRET;
const appEnv = env as unknown as Env;

// ── schema setup ─────────────────────────────────────────────────────────────

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

// ── helpers ───────────────────────────────────────────────────────────────────

function url(path: string): string {
  return `https://test.local${path}`;
}

interface SeedSessionResult {
  rawId: string;
  idHash: string;
}

// Seed a session row and return both the raw cookie id and the stored hash.
async function seedSessionRow(args: {
  login: string;
  expiresAt: number;
}): Promise<SeedSessionResult> {
  const rawId = randomToken(32);
  const idHash = await sha256Hex(rawId);
  const tokenEnc = await encrypt('gho_testtoken', SESSION_SECRET);
  await DB.prepare(
    `INSERT INTO sessions
       (id, login, name, avatar_url, scopes, token_enc, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      idHash,
      args.login,
      args.login,
      'https://avatar.example/x.png',
      'read:user',
      tokenEnc,
      args.expiresAt,
    )
    .run();
  return { rawId, idHash };
}

async function seedUser(login: string): Promise<void> {
  const now = Date.now();
  await DB.prepare(
    `INSERT OR REPLACE INTO users
       (login, name, avatar_url, role, suspended_at, suspended_reason,
        suspended_by, includes_private, scan_count, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'user', NULL, NULL, NULL, 0, 0, ?, ?)`,
  )
    .bind(login, login, 'https://avatar.example/x.png', now, now)
    .run();
}

async function countSessionRows(idHash: string): Promise<number> {
  const row = await DB.prepare(
    `SELECT COUNT(*) AS n FROM sessions WHERE id = ?`,
  )
    .bind(idHash)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function totalSessionRows(): Promise<number> {
  const row = await DB.prepare(
    `SELECT COUNT(*) AS n FROM sessions`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

// ── Step 1: session lifecycle ─────────────────────────────────────────────────

beforeEach(async () => {
  await applyMigrations();
});

describe('session lifecycle', () => {
  it('returns 401 and deletes the row for an expired session', async () => {
    await seedUser('alice');
    const { rawId, idHash } = await seedSessionRow({
      login: 'alice',
      expiresAt: Date.now() - 1_000, // already expired
    });

    const res = await SELF.fetch(url('/api/me'), {
      headers: { Cookie: `rs_session=${rawId}` },
    });

    // STOP condition: must be 401 — if not, expired sessions aren't rejected.
    expect(res.status).toBe(401);

    // The row must have been deleted by getSession.
    expect(await countSessionRows(idHash)).toBe(0);
  });

  it('returns 200 for a valid (future-expiry) session', async () => {
    await seedUser('bob');
    const { rawId } = await seedSessionRow({
      login: 'bob',
      expiresAt: Date.now() + 60 * 60 * 1_000,
    });

    const res = await SELF.fetch(url('/api/me'), {
      headers: { Cookie: `rs_session=${rawId}` },
    });

    expect(res.status).toBe(200);
  });

  it('sweepExpiredSessions removes only expired rows', async () => {
    const now = Date.now();

    // One expired, one valid.
    await seedSessionRow({ login: 'x', expiresAt: now - 5_000 });
    await seedSessionRow({ login: 'y', expiresAt: now + 60 * 60 * 1_000 });

    expect(await totalSessionRows()).toBe(2);

    await sweepExpiredSessions(appEnv, now);

    // Only the valid row should remain.
    expect(await totalSessionRows()).toBe(1);
  });
});

// ── Step 2: OAuth state-rejection branches ────────────────────────────────────

describe('OAuth state-check branches (/auth/callback)', () => {
  // These branches redirect before any outbound fetch to GitHub — no mock needed.

  it('redirects with oauth_missing_params when code/state are absent', async () => {
    const res = await SELF.fetch(url('/auth/callback'), {
      redirect: 'manual',
    });

    const location = res.headers.get('location') ?? '';
    expect(res.status === 302 || res.status === 301 || res.status === 303).toBe(
      true,
    );
    expect(location).toContain('error=oauth_missing_params');
  });

  it('redirects with oauth_bad_state when the state cookie signature is invalid', async () => {
    const res = await SELF.fetch(
      url('/auth/callback?state=somestate&code=somecode'),
      {
        redirect: 'manual',
        headers: { Cookie: 'rs_oauth_state=garbage_not_a_valid_signature' },
      },
    );

    const location = res.headers.get('location') ?? '';
    expect(res.status === 302 || res.status === 301 || res.status === 303).toBe(
      true,
    );
    expect(location).toContain('error=oauth_bad_state');
  });

  it('redirects with oauth_state_mismatch when signed state does not match query param', async () => {
    // Sign 'abc:0' so the embedded state is 'abc', but pass ?state=different.
    const signedCookie = await sign('abc:0', SESSION_SECRET);

    const res = await SELF.fetch(
      url('/auth/callback?state=different&code=somecode'),
      {
        redirect: 'manual',
        // STOP condition: if this does NOT return oauth_state_mismatch, the
        // CSRF guard is broken.
        headers: { Cookie: `rs_oauth_state=${signedCookie}` },
      },
    );

    const location = res.headers.get('location') ?? '';
    expect(res.status === 302 || res.status === 301 || res.status === 303).toBe(
      true,
    );
    expect(location).toContain('error=oauth_state_mismatch');
  });
});

// ── Step 3: OAuth happy path (requires outbound fetch stubbing) ───────────────

describe('OAuth happy path', () => {
  afterEach(() => {
    // Deactivate the mock agent after each test so other tests get real fetch.
    fetchMock.deactivate();
  });

  it('creates a session and redirects to /?signed_in=1 on successful OAuth', async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();

    // Stub GitHub token exchange.
    fetchMock
      .get('https://github.com')
      .intercept({ path: '/login/oauth/access_token', method: 'POST' })
      .reply(
        200,
        JSON.stringify({
          access_token: 'gho_fakegithubtoken',
          scope: 'read:user',
          token_type: 'bearer',
        }),
        { headers: { 'content-type': 'application/json' } },
      );

    // Stub GitHub user API.
    fetchMock
      .get('https://api.github.com')
      .intercept({ path: '/user', method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          login: 'integrationuser',
          name: 'Integration User',
          avatar_url: 'https://avatars.example/u.png',
        }),
        { headers: { 'content-type': 'application/json' } },
      );

    // Build a validly-signed state cookie matching the query param 'teststate'.
    const signedCookie = await sign('teststate:0', SESSION_SECRET);

    const res = await SELF.fetch(
      url('/auth/callback?state=teststate&code=real-code'),
      {
        redirect: 'manual',
        headers: { Cookie: `rs_oauth_state=${signedCookie}` },
      },
    );

    const location = res.headers.get('location') ?? '';
    expect(res.status === 302 || res.status === 301 || res.status === 303).toBe(
      true,
    );
    expect(location).toContain('signed_in=1');

    // A session row should have been created.
    expect(await totalSessionRows()).toBe(1);
  });
});
