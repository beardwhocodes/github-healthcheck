import { describe, expect, it } from 'vitest';

import { normalizeWatchTargets } from '../src/alerts/watch-targets.js';

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('normalizeWatchTargets — happy path', () => {
  it('accepts a plain owner/repo string', () => {
    const { ok, rejected } = normalizeWatchTargets(['torvalds/linux'], 20);
    expect(ok).toEqual(['torvalds/linux']);
    expect(rejected).toHaveLength(0);
  });

  it('accepts a github.com URL and strips to owner/repo', () => {
    const { ok } = normalizeWatchTargets(
      ['https://github.com/vercel/next.js'],
      20,
    );
    expect(ok).toEqual(['vercel/next.js']);
  });

  it('accepts a URL with a trailing .git suffix', () => {
    const { ok } = normalizeWatchTargets(
      ['https://github.com/facebook/react.git'],
      20,
    );
    expect(ok).toEqual(['facebook/react']);
  });

  it('accepts multiple distinct repos up to the cap', () => {
    const inputs = [
      'owner/repo-a',
      'owner/repo-b',
      'https://github.com/owner/repo-c',
    ];
    const { ok, rejected } = normalizeWatchTargets(inputs, 20);
    expect(ok).toHaveLength(3);
    expect(rejected).toHaveLength(0);
  });

  it('preserves the original owner/name casing in the output', () => {
    const { ok } = normalizeWatchTargets(['Microsoft/TypeScript'], 20);
    expect(ok).toEqual(['Microsoft/TypeScript']);
  });
});

// ---------------------------------------------------------------------------
// Rejection — invalid target
// ---------------------------------------------------------------------------

describe('normalizeWatchTargets — invalid targets', () => {
  it('rejects an empty string (after trim)', () => {
    const { ok, rejected } = normalizeWatchTargets(['   '], 20);
    // blank inputs are silently skipped, not added to rejected
    expect(ok).toHaveLength(0);
    expect(rejected).toHaveLength(0);
  });

  it('rejects a path with invalid name characters', () => {
    const { rejected } = normalizeWatchTargets(['owner/<script>'], 20);
    expect(rejected[0]).toMatchObject({ reason: 'invalid_target' });
  });

  it('rejects a bare owner string (account-level target)', () => {
    const { rejected } = normalizeWatchTargets(['torvalds'], 20);
    expect(rejected[0]).toMatchObject({
      input: 'torvalds',
      reason: 'account_target_not_supported',
    });
  });

  it('rejects a github.com URL that resolves to an account', () => {
    const { rejected } = normalizeWatchTargets(
      ['https://github.com/torvalds'],
      20,
    );
    expect(rejected[0]).toMatchObject({
      reason: 'account_target_not_supported',
    });
  });

  it('rejects a completely nonsense string', () => {
    const { rejected } = normalizeWatchTargets(['not a repo at all!!!'], 20);
    expect(rejected[0]).toMatchObject({ reason: 'invalid_target' });
  });
});

// ---------------------------------------------------------------------------
// Rejection — duplicates
// ---------------------------------------------------------------------------

describe('normalizeWatchTargets — deduplication', () => {
  it('rejects the second occurrence of the same repo', () => {
    const { ok, rejected } = normalizeWatchTargets(
      ['owner/repo', 'owner/repo'],
      20,
    );
    expect(ok).toEqual(['owner/repo']);
    expect(rejected[0]).toMatchObject({ input: 'owner/repo', reason: 'duplicate' });
  });

  it('deduplicates case-insensitively', () => {
    const { ok, rejected } = normalizeWatchTargets(
      ['Owner/Repo', 'owner/repo'],
      20,
    );
    expect(ok).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: 'duplicate' });
  });

  it('URL and plain form of same repo are treated as duplicates', () => {
    const { ok, rejected } = normalizeWatchTargets(
      ['torvalds/linux', 'https://github.com/torvalds/linux'],
      20,
    );
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: 'duplicate' });
  });
});

// ---------------------------------------------------------------------------
// Rejection — cap enforcement
// ---------------------------------------------------------------------------

describe('normalizeWatchTargets — cap enforcement', () => {
  it('accepts exactly `max` inputs and rejects the rest', () => {
    const inputs = Array.from({ length: 25 }, (_, i) => `owner/repo-${i}`);
    const { ok, rejected } = normalizeWatchTargets(inputs, 20);
    expect(ok).toHaveLength(20);
    expect(rejected).toHaveLength(5);
    expect(rejected.every((r) => r.reason === 'cap_exceeded')).toBe(true);
  });

  it('respects a cap of 1', () => {
    const { ok, rejected } = normalizeWatchTargets(
      ['a/b', 'c/d'],
      1,
    );
    expect(ok).toEqual(['a/b']);
    expect(rejected[0]).toMatchObject({ input: 'c/d', reason: 'cap_exceeded' });
  });

  it('throws RangeError for max <= 0', () => {
    expect(() => normalizeWatchTargets(['a/b'], 0)).toThrow(RangeError);
    expect(() => normalizeWatchTargets(['a/b'], -1)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Mixed input
// ---------------------------------------------------------------------------

describe('normalizeWatchTargets — mixed input', () => {
  it('handles a realistic mixed list correctly', () => {
    const inputs = [
      'https://github.com/vercel/next.js',
      'facebook/react',
      'torvalds',                          // account — rejected
      'not-valid!!!',                      // invalid — rejected
      'facebook/react',                    // duplicate — rejected
      'microsoft/vscode',
    ];
    const { ok, rejected } = normalizeWatchTargets(inputs, 20);
    expect(ok).toEqual(['vercel/next.js', 'facebook/react', 'microsoft/vscode']);
    expect(rejected).toHaveLength(3);
    expect(rejected.map((r) => r.reason)).toEqual([
      'account_target_not_supported',
      'invalid_target',
      'duplicate',
    ]);
  });
});
