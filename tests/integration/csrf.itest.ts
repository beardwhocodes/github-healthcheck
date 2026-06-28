// CSRF / Origin-check integration tests. These run against the real Worker via
// SELF.fetch (miniflare), so the full middleware chain executes — no mocks.
import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { env } from 'cloudflare:test';

const migrationModules = import.meta.glob('../../migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

async function applyMigrations(): Promise<void> {
  const DB = (env as unknown as { DB: D1Database }).DB;
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

beforeEach(async () => {
  await applyMigrations();
});

describe('CSRF origin check', () => {
  it('(a) rejects a cross-origin POST with 403 before auth runs', async () => {
    // A cross-origin POST must be stopped by the CSRF gate (403), not let through
    // to requireAuth (which would return 401). This proves the CSRF check fires
    // before authentication and rejects the foreign origin.
    const res = await SELF.fetch(url('/api/contact'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ name: 'Eve', email: 'eve@evil.example', message: 'hi' }),
    });
    expect(res.status).toBe(403);
  });

  it('(b) lets a same-origin POST pass CSRF and then hit requireAuth (401)', async () => {
    // Without a session, a legitimate same-origin POST must not be blocked by the
    // CSRF gate — it should reach requireAuth, which returns 401. This proves that
    // genuine same-origin requests are not accidentally CSRF-rejected.
    const res = await SELF.fetch(url('/api/contact'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Browsers attach Origin to unsafe-method requests even same-origin, so a
        // legitimate same-origin mutation carries our own origin. The CSRF gate
        // now fails closed on a *missing* Origin, so the matching origin is what
        // lets a real same-origin request through to auth.
        Origin: 'https://test.local',
      },
      body: JSON.stringify({ name: 'Alice', email: 'alice@test.local', message: 'hi' }),
    });
    // CSRF gate passes (origin matches our own); requireAuth returns 401 because
    // there is no session cookie.
    expect(res.status).toBe(401);
  });

  it('(c) does not block a cross-origin GET (safe method unaffected)', async () => {
    // Safe methods (GET) must not be rejected by the CSRF gate regardless of Origin.
    // Without a session the response will be 401 from requireAuth — NOT 403.
    const res = await SELF.fetch(url('/api/me'), {
      headers: {
        Origin: 'https://evil.example',
      },
    });
    // 401 means the CSRF check was not triggered; the request reached requireAuth.
    expect(res.status).toBe(401);
  });
});
