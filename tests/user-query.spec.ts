import { describe, expect, it } from 'vitest';

import { buildUserListQuery } from '../src/users/store.js';

const SINCE = 1_700_000_000_000;

function placeholderCount(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}

describe('buildUserListQuery', () => {
  it('binds exactly the velocity window and limit when unfiltered', () => {
    const { sql, binds } = buildUserListQuery({ since24h: SINCE, status: 'all', limit: 100 });
    expect(binds).toEqual([SINCE, 100]);
    // The invariant that guards every future filter addition: one bind per ?.
    expect(placeholderCount(sql)).toBe(binds.length);
  });

  it('derives velocity from rate_events (scan-day bucket), not an identity-linked scan log', () => {
    const { sql } = buildUserListQuery({ since24h: SINCE, status: 'all', limit: 100 });
    // The privacy redesign reads the trailing-24h scan velocity from rate_events;
    // the old per-scan `scans` table is gone and must not be referenced.
    expect(sql).toContain('FROM rate_events');
    expect(sql).toContain("bucket LIKE 'scan-day:%'");
    expect(sql).not.toMatch(/\bFROM scans\b/);
  });

  it('searches login OR name with two binds, in placeholder order', () => {
    const { sql, binds } = buildUserListQuery({
      since24h: SINCE,
      query: 'octocat',
      status: 'all',
      limit: 50,
    });
    expect(sql).toContain("u.login LIKE ? ESCAPE '\\'");
    expect(sql).toContain("u.name LIKE ? ESCAPE '\\'");
    // Order must be: velocity window, search, search, limit.
    expect(binds).toEqual([SINCE, '%octocat%', '%octocat%', 50]);
    expect(placeholderCount(sql)).toBe(binds.length);
  });

  it('escapes LIKE wildcards so % and _ match literally', () => {
    const { sql, binds } = buildUserListQuery({
      since24h: SINCE,
      query: '50%_off',
      status: 'all',
      limit: 10,
    });
    // % and _ (and any backslash) in the term are escaped so they are matched as
    // literal characters rather than acting as wildcards.
    expect(binds).toEqual([SINCE, '%50\\%\\_off%', '%50\\%\\_off%', 10]);
    expect(placeholderCount(sql)).toBe(binds.length);
  });

  it('adds literal status predicates without extra binds', () => {
    const suspended = buildUserListQuery({ since24h: SINCE, status: 'suspended', limit: 10 });
    expect(suspended.sql).toContain('u.suspended_at IS NOT NULL');
    expect(suspended.binds).toEqual([SINCE, 10]);

    const active = buildUserListQuery({ since24h: SINCE, status: 'active', limit: 10 });
    expect(active.sql).toContain('u.suspended_at IS NULL');

    const admins = buildUserListQuery({ since24h: SINCE, status: 'admin', limit: 10 });
    expect(admins.sql).toContain("u.role = 'admin'");
    expect(admins.binds).toEqual([SINCE, 10]);
  });

  it('keeps the ?-count and bind-count in lockstep with a search + status combined', () => {
    const { sql, binds } = buildUserListQuery({
      since24h: SINCE,
      query: 'a',
      status: 'suspended',
      limit: 25,
    });
    expect(placeholderCount(sql)).toBe(binds.length);
    expect(binds).toEqual([SINCE, '%a%', '%a%', 25]);
  });

  it('clamps the limit to [1, 500]', () => {
    expect(buildUserListQuery({ since24h: SINCE, limit: 9999 }).binds.at(-1)).toBe(500);
    expect(buildUserListQuery({ since24h: SINCE, limit: 0 }).binds.at(-1)).toBe(1);
    expect(buildUserListQuery({ since24h: SINCE, limit: -5 }).binds.at(-1)).toBe(1);
  });
});
