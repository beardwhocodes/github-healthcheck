// Integration tests for the email capability-token flow (M3 hardening): verify
// tokens succeed, expire, and reject garbage; unsubscribe ERASES the stored
// encrypted GitHub token (token_enc) and the user's watched/known-clone rows.
// Tokens are stored only as SHA-256 hashes, so these exercise the real store +
// real miniflare D1 — a pure unit test can't prove the hash round-trip or the
// at-rest token erasure. Expiry is driven by passing an explicit `now` (never the
// wall clock) so the test is deterministic.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env.js';
import {
  deactivateByUnsubscribeToken,
  getSubscription,
  upsertSubscription,
  verifyByToken,
} from '../../src/alerts/store.js';

const appEnv = env as unknown as Env;
const DB = (env as unknown as { DB: D1Database }).DB;

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
const VERIFY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Create a fresh (unverified) subscription with known RAW tokens. The store
// hashes them at rest; the raw values are what an email link would carry.
async function seedSub(args: {
  login: string;
  verifyToken: string;
  unsubscribeToken: string;
  now?: number;
}): Promise<void> {
  await upsertSubscription(appEnv, {
    login: args.login,
    email: `${args.login}@example.com`,
    tokenEnc: 'enc-blob-not-empty', // stand-in for an AES-GCM token blob
    verifyToken: args.verifyToken,
    unsubscribeToken: args.unsubscribeToken,
    now: args.now ?? NOW,
  });
}

function url(path: string): string {
  return `https://test.local${path}`;
}

beforeEach(async () => {
  await applyMigrations();
});

describe('email verify token', () => {
  it('confirms a valid, unexpired token and clears the token at rest', async () => {
    await seedSub({ login: 'vuser', verifyToken: 'rawverify', unsubscribeToken: 'rawunsub' });

    const sub = await verifyByToken(appEnv, 'rawverify', NOW + 1_000);
    expect(sub).not.toBeNull();
    expect(sub?.verified).toBe(1);

    const row = await getSubscription(appEnv, 'vuser');
    expect(row?.verified).toBe(1);
    // The one-time verify token is consumed: hash cleared, expiry cleared.
    expect(row?.verifyToken).toBeNull();
    expect(row?.verifyExpiresAt).toBeNull();
  });

  it('rejects an expired token without verifying (deterministic via explicit now)', async () => {
    await seedSub({ login: 'euser', verifyToken: 'rawverify', unsubscribeToken: 'rawunsub' });

    // One millisecond past the 7-day TTL set at seed time.
    const sub = await verifyByToken(appEnv, 'rawverify', NOW + VERIFY_TTL_MS + 1);
    expect(sub).toBeNull();

    const row = await getSubscription(appEnv, 'euser');
    expect(row?.verified).toBe(0); // still unverified
    expect(row?.verifyToken).not.toBeNull(); // token NOT consumed
  });

  it('rejects an unknown/garbage token', async () => {
    await seedSub({ login: 'guser', verifyToken: 'rawverify', unsubscribeToken: 'rawunsub' });

    expect(await verifyByToken(appEnv, 'not-the-token', NOW)).toBeNull();
    expect(await verifyByToken(appEnv, '', NOW)).toBeNull();
  });

  it('drives a successful verify end-to-end through GET /email/verify', async () => {
    // The route reads Date.now() for the expiry check, so seed the 7-day TTL
    // relative to the real clock (the store-level tests above pin `now` instead).
    await seedSub({
      login: 'wuser',
      verifyToken: 'routeverify',
      unsubscribeToken: 'routeunsub',
      now: Date.now(),
    });

    const res = await SELF.fetch(url('/email/verify?token=routeverify'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Email confirmed');

    const row = await getSubscription(appEnv, 'wuser');
    expect(row?.verified).toBe(1);
  });

  it('returns the "Link expired" page (400) for a bad token via the route', async () => {
    const res = await SELF.fetch(url('/email/verify?token=does-not-exist'));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Link expired');
  });
});

describe('email unsubscribe token', () => {
  it('erases the encrypted credential and clears watched/known rows', async () => {
    await seedSub({ login: 'uuser', verifyToken: 'rawverify', unsubscribeToken: 'rawunsub' });
    // Things that must stop running once unsubscribed.
    await DB.prepare(`INSERT INTO watched_repos (login, full_name) VALUES (?, ?)`)
      .bind('uuser', 'uuser/repo')
      .run();
    await DB.prepare(
      `INSERT INTO known_clones (login, source_repo, suspect_repo, confidence, first_seen, notified)
       VALUES (?, ?, ?, 90, ?, 1)`,
    )
      .bind('uuser', 'uuser/repo', 'evil/clone', NOW)
      .run();

    const login = await deactivateByUnsubscribeToken(appEnv, 'rawunsub');
    expect(login).toBe('uuser');

    const row = await getSubscription(appEnv, 'uuser');
    expect(row?.active).toBe(0);
    // The dormant encrypted GitHub token must be wiped, not just disabled.
    expect(row?.tokenEnc).toBe('');
    expect(row?.unsubscribeToken).toBeNull();
    expect(row?.verifyToken).toBeNull();

    const watched = await DB.prepare(`SELECT COUNT(*) AS n FROM watched_repos WHERE login = ?`)
      .bind('uuser')
      .first<{ n: number }>();
    const known = await DB.prepare(`SELECT COUNT(*) AS n FROM known_clones WHERE login = ?`)
      .bind('uuser')
      .first<{ n: number }>();
    expect(watched?.n).toBe(0);
    expect(known?.n).toBe(0);
  });

  it('rejects an unknown unsubscribe token', async () => {
    expect(await deactivateByUnsubscribeToken(appEnv, 'nope')).toBeNull();
    expect(await deactivateByUnsubscribeToken(appEnv, '')).toBeNull();
  });

  it('drives RFC 8058 one-click unsubscribe through POST /email/unsubscribe', async () => {
    await seedSub({ login: 'puser', verifyToken: 'rawverify', unsubscribeToken: 'postunsub' });

    const res = await SELF.fetch(url('/email/unsubscribe?token=postunsub'), { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Unsubscribed');

    const row = await getSubscription(appEnv, 'puser');
    expect(row?.active).toBe(0);
    expect(row?.tokenEnc).toBe('');
  });
});
