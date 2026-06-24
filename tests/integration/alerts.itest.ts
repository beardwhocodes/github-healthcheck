// Store-contract regression tests for the alert clone-suppression logic.
// These exercise real miniflare D1 SQL — the pure unit suite cannot catch
// a broken `notified` filter or a downgrade in the ON CONFLICT clause.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env.js';
import { getKnownSuspectRepos, recordClones } from '../../src/alerts/store.js';

const appEnv = env as unknown as Env;
const DB = (env as unknown as { DB: D1Database }).DB;

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
      .replace(/--[^\n]*/g, '') // strip comments
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await DB.prepare(stmt).run();
    }
  }
}

beforeEach(async () => {
  await applyMigrations();
});

const BASE_CLONE = {
  sourceRepo: 'alice/original',
  suspectRepo: 'EvilOrg/Repo',
  confidence: 90,
  firstSeen: 1_700_000_000,
};

describe('getKnownSuspectRepos / recordClones contract', () => {
  it('does NOT suppress an unsent clone (notified: false is invisible to the baseline)', async () => {
    await recordClones(appEnv, 'alice', [{ ...BASE_CLONE, notified: false }]);
    const known = await getKnownSuspectRepos(appEnv, 'alice');
    expect(known.size).toBe(0);
  });

  it('suppresses a sent clone (notified: true appears in the baseline, lowercased)', async () => {
    await recordClones(appEnv, 'alice', [{ ...BASE_CLONE, notified: true }]);
    const known = await getKnownSuspectRepos(appEnv, 'alice');
    expect(known.has('evilorg/repo')).toBe(true);
  });

  it('upgrades to known after a failed-then-successful send', async () => {
    // First attempt: email failed — record with notified: false
    await recordClones(appEnv, 'alice', [{ ...BASE_CLONE, notified: false }]);
    const knownBefore = await getKnownSuspectRepos(appEnv, 'alice');
    expect(knownBefore.size).toBe(0);

    // Second attempt: email succeeded — record same (login, suspect_repo) with notified: true
    await recordClones(appEnv, 'alice', [{ ...BASE_CLONE, notified: true }]);
    const knownAfter = await getKnownSuspectRepos(appEnv, 'alice');
    expect(knownAfter.has('evilorg/repo')).toBe(true);
  });

  it('does NOT downgrade a sent clone if a later unsent run re-records it', async () => {
    // Already successfully notified
    await recordClones(appEnv, 'alice', [{ ...BASE_CLONE, notified: true }]);

    // A later cron run (email failed again) must not flip notified back to 0
    await recordClones(appEnv, 'alice', [{ ...BASE_CLONE, notified: false }]);
    const known = await getKnownSuspectRepos(appEnv, 'alice');
    expect(known.has('evilorg/repo')).toBe(true);
  });
});
