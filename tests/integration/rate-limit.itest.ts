// Real-flow rate-limit tests: prove the per-user limiter ACTUALLY returns 429
// past the budget and that admins are exempt — driven through the real Worker +
// miniflare D1, not a mock. Uses POST /api/reports (the WRITE tier) because it
// records to D1 with no GitHub/network dependency, so the test is fast and
// deterministic while still exercising the same middleware all scan routes use.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { encrypt, randomToken, sha256Hex } from '../../src/auth/crypto.js';
import { WRITE_BURST } from '../../src/routes/rate-limit.js';

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

function postReport(cookie: string, suspect: string): Promise<Response> {
  return SELF.fetch('https://test.local/api/reports', {
    method: 'POST',
    headers: { Cookie: `rs_session=${cookie}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ suspectRepo: suspect, category: 'malware' }),
  });
}

beforeEach(async () => {
  await applyMigrations();
});

describe('per-user rate limiting', () => {
  it('returns 429 with Retry-After once a non-admin exceeds the write budget', async () => {
    const cookie = await seedSession('mallory');

    // The first `limit` requests are accepted...
    for (let i = 0; i < WRITE_BURST.limit; i++) {
      const ok = await postReport(cookie, `evil/repo-${i}`);
      expect(ok.status).toBe(200);
    }
    // ...the next one is rejected by the limiter.
    const blocked = await postReport(cookie, 'evil/one-too-many');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    const body = (await blocked.json()) as { error: string };
    expect(body.error).toBe('rate_limited');
  });

  it('exempts admins from the limit', async () => {
    const cookie = await seedSession('copyjosh'); // bootstrap admin
    for (let i = 0; i < WRITE_BURST.limit + 3; i++) {
      const res = await postReport(cookie, `evil/repo-${i}`);
      expect(res.status).toBe(200);
    }
  });
});
