// Integration test for the scans retention sweep (pruneOldScans). The cron drops
// scan-log rows older than the 60-day window so the table can't grow without
// bound. Exercises the real DELETE against miniflare D1; time is passed in
// explicitly (no wall clock) so the test is deterministic.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env.js';
import { countAllScans, pruneOldScans } from '../../src/scans/store.js';

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
const DAY = 24 * 60 * 60 * 1000;

async function seedScan(id: string, createdAt: number): Promise<void> {
  await DB.prepare(
    `INSERT INTO scans (id, login, kind, target, top_score, created_at) VALUES (?, 'u', 'self', NULL, 0, ?)`,
  )
    .bind(id, createdAt)
    .run();
}

beforeEach(async () => {
  await applyMigrations();
});

describe('pruneOldScans (60-day retention)', () => {
  it('deletes only rows older than the cutoff and reports the count', async () => {
    await seedScan('old1', NOW - 61 * DAY);
    await seedScan('old2', NOW - 90 * DAY);
    await seedScan('edge', NOW - 60 * DAY); // exactly at the window edge → kept
    await seedScan('fresh', NOW - 1 * DAY);

    const cutoff = NOW - 60 * DAY;
    const removed = await pruneOldScans(appEnv, cutoff);

    expect(removed).toBe(2); // old1 + old2
    expect(await countAllScans(appEnv)).toBe(2); // edge + fresh remain

    const ids = await DB.prepare(`SELECT id FROM scans ORDER BY id`).all<{ id: string }>();
    expect((ids.results ?? []).map((r) => r.id)).toEqual(['edge', 'fresh']);
  });

  it('is a no-op when nothing is old enough', async () => {
    await seedScan('a', NOW - 1 * DAY);
    expect(await pruneOldScans(appEnv, NOW - 60 * DAY)).toBe(0);
    expect(await countAllScans(appEnv)).toBe(1);
  });
});
