// Integration test for the aggregate-only scan accounting (recordScan + the
// scan_daily readers) against real miniflare D1. The privacy redesign replaced
// the per-scan, identity-linked `scans` table with an anonymous per-day/per-kind
// counter; this proves the UPSERT increments the right (day, kind) bucket and
// bumps the user's own scan_count, with no identity/target retained.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env.js';
import {
  countAllScans,
  countScansByKind,
  countScansSince,
  recordScan,
} from '../../src/scans/store.js';

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

const NOW = Date.parse('2026-06-19T12:00:00Z');
const DAY = new Date(NOW).toISOString().slice(0, 10); // '2026-06-19' (UTC)

async function seedUser(login: string): Promise<void> {
  await DB.prepare(
    `INSERT INTO users (login, name, avatar_url, role, includes_private, scan_count, first_seen_at, last_seen_at)
       VALUES (?, ?, NULL, 'user', 0, 0, ?, ?)`,
  )
    .bind(login, login, NOW, NOW)
    .run();
}

async function dailyCount(day: string, kind: string): Promise<number> {
  const row = await DB.prepare(`SELECT count FROM scan_daily WHERE day = ? AND kind = ?`)
    .bind(day, kind)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function scanCount(login: string): Promise<number> {
  const row = await DB.prepare(`SELECT scan_count FROM users WHERE login = ?`)
    .bind(login)
    .first<{ scan_count: number }>();
  return row?.scan_count ?? 0;
}

beforeEach(async () => {
  await applyMigrations();
});

describe('recordScan increments scan_daily(day, kind) and users.scan_count', () => {
  it('upserts the per-day/per-kind counter and bumps the user counter', async () => {
    await seedUser('octocat');

    await recordScan(appEnv, { login: 'octocat', kind: 'repo', now: NOW });
    await recordScan(appEnv, { login: 'octocat', kind: 'repo', now: NOW });
    await recordScan(appEnv, { login: 'octocat', kind: 'self', now: NOW });

    // The (day, kind) buckets accumulate via ON CONFLICT ... count = count + 1.
    expect(await dailyCount(DAY, 'repo')).toBe(2);
    expect(await dailyCount(DAY, 'self')).toBe(1);

    // The user's own activity counter advances once per scan.
    expect(await scanCount('octocat')).toBe(3);

    // Aggregate readers reflect the counters; no identity/target is stored.
    expect(await countAllScans(appEnv)).toBe(3);
    expect(await countScansByKind(appEnv)).toEqual({ repo: 2, self: 1 });
    expect(await countScansSince(appEnv, NOW)).toBe(3);
    expect(await countScansSince(appEnv, Date.parse('2026-06-20T00:00:00Z'))).toBe(0);
  });
});
