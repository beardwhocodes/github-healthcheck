// Happy-path scan/report integration tests. The existing suite only covers the
// error tiers (401/403/429); this proves a 200 actually flows through the real
// Worker (origin gate + requireAuth + requireNotSuspended + rate limit) and
// returns the documented response SHAPE, with the GitHub API mocked. /api/scan
// and /api/report are both POST (converted from GET in the CSRF hardening pass,
// since each writes a scan-log row), so both require a same-origin Origin header.
import { env, fetchMock, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { encrypt, randomToken, sha256Hex } from '../../src/auth/crypto.js';

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

// Seed a valid session and return its raw cookie id. APP_URL is https in the
// test env, so the cookie is read under the __Host- prefix (see session.ts).
async function seedSession(login: string): Promise<string> {
  const rawId = randomToken(32);
  const idHash = await sha256Hex(rawId);
  const tokenEnc = await encrypt('gho_testtoken', SESSION_SECRET);
  await DB.prepare(
    `INSERT INTO sessions (id, login, name, avatar_url, scopes, token_enc, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(idHash, login, login, 'https://avatar.example/x.png', 'read:user', tokenEnc, Date.now() + 3_600_000)
    .run();
  return rawId;
}

function url(path: string): string {
  return `https://test.local${path}`;
}

const JSON_HEADERS = { headers: { 'content-type': 'application/json' } };

// A real, old account so the engine emits a deterministic (non-erroring) report.
const ACCOUNT = {
  login: 'octocat',
  name: 'The Octocat',
  type: 'User',
  avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
  html_url: 'https://github.com/octocat',
  created_at: '2011-01-25T18:44:36Z',
  followers: 1000,
  following: 0,
  public_repos: 2,
};

beforeEach(async () => {
  await applyMigrations();
});

afterEach(() => {
  fetchMock.deactivate();
});

describe('POST /api/scan (account, happy path)', () => {
  it('returns 200 with the account report shape', async () => {
    const rawId = await seedSession('scanner');

    fetchMock.activate();
    fetchMock.disableNetConnect();
    const gh = fetchMock.get('https://api.github.com');
    gh.intercept({ path: '/users/octocat', method: 'GET' }).reply(
      200,
      JSON.stringify(ACCOUNT),
      JSON_HEADERS,
    );
    gh.intercept({ path: /^\/users\/octocat\/repos/, method: 'GET' }).reply(
      200,
      '[]',
      JSON_HEADERS,
    );

    const res = await SELF.fetch(url('/api/scan?target=octocat'), {
      method: 'POST',
      headers: { Cookie: `__Host-rs_session=${rawId}`, Origin: 'https://test.local' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      scanned: number;
      totalRepos: number;
      report: { score: number; band: string; account: { login: string }; findings: unknown[]; repoReports: unknown[] };
    };
    expect(body.kind).toBe('account');
    expect(body.scanned).toBe(0);
    expect(body.totalRepos).toBe(0);
    expect(body.report.account.login).toBe('octocat');
    expect(typeof body.report.score).toBe('number');
    expect(typeof body.report.band).toBe('string');
    expect(Array.isArray(body.report.findings)).toBe(true);
    expect(Array.isArray(body.report.repoReports)).toBe(true);
  });

  it('still rejects the same POST without an Origin header (CSRF gate)', async () => {
    const rawId = await seedSession('scanner2');
    const res = await SELF.fetch(url('/api/scan?target=octocat'), {
      method: 'POST',
      headers: { Cookie: `__Host-rs_session=${rawId}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/report (self-audit, happy path)', () => {
  it('returns 200 with the report rollup shape', async () => {
    const rawId = await seedSession('selfscanner');

    fetchMock.activate();
    fetchMock.disableNetConnect();
    const gh = fetchMock.get('https://api.github.com');
    gh.intercept({ path: '/user', method: 'GET' }).reply(
      200,
      JSON.stringify({ ...ACCOUNT, login: 'selfscanner', two_factor_authentication: true }),
      JSON_HEADERS,
    );
    gh.intercept({ path: /^\/user\/repos/, method: 'GET' }).reply(200, '[]', JSON_HEADERS);

    // POST now (writes a scan log), so the origin gate applies — send Origin.
    const res = await SELF.fetch(url('/api/report'), {
      method: 'POST',
      headers: { Cookie: `__Host-rs_session=${rawId}`, Origin: 'https://test.local' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scanned: number;
      totalRepos: number;
      report: { score: number; account: { login: string }; summary: { reposScanned: number } };
    };
    expect(body.scanned).toBe(0);
    expect(body.totalRepos).toBe(0);
    expect(body.report.account.login).toBe('selfscanner');
    expect(typeof body.report.score).toBe('number');
    expect(body.report.summary.reposScanned).toBe(0);
  });
});
