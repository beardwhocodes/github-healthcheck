import { describe, expect, it, vi } from 'vitest';

import type { GitHubClient } from '../src/github/client.js';
import type { RawCommit } from '../src/github/client.js';
import {
  buildRepoSnapshotSafe,
  mapWithConcurrency,
} from '../src/github/snapshot.js';

// ---------------------------------------------------------------------------
// mapWithConcurrency
// ---------------------------------------------------------------------------

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    // Reverse-delay: item 0 is slowest, item 2 is fastest.
    const delays = [30, 10, 0];
    const result = await mapWithConcurrency(
      [0, 1, 2],
      3,
      (n) =>
        new Promise<number>((resolve) =>
          setTimeout(() => resolve(n * 10), delays[n]!),
        ),
    );
    expect(result).toEqual([0, 10, 20]);
  });

  it('respects the concurrency cap', async () => {
    let inFlight = 0;
    let maxObserved = 0;

    // Use deferred promises so we can control when each item resolves.
    const resolvers: (() => void)[] = [];
    const items = [0, 1, 2, 3, 4];
    const cap = 2;

    const runPromise = mapWithConcurrency(items, cap, (_n) => {
      inFlight++;
      if (inFlight > maxObserved) maxObserved = inFlight;
      return new Promise<void>((resolve) => {
        resolvers.push(() => {
          inFlight--;
          resolve();
        });
      });
    });

    // Drain in microtask-safe batches: let workers pick up work, then settle.
    const drain = async (n: number) => {
      // Wait for the scheduler to fill up to the cap.
      await Promise.resolve();
      await Promise.resolve();
      for (let i = 0; i < n; i++) {
        resolvers.shift()?.();
        await Promise.resolve();
        await Promise.resolve();
      }
    };

    await drain(2); // first batch
    await drain(2); // second batch
    await drain(1); // final item
    await runPromise;

    expect(maxObserved).toBeLessThanOrEqual(cap);
  });

  it('drops a rejecting item but keeps its siblings (allSettled-style)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('intentional failure');
        return n;
      });
      // The bad item is filtered out; the others survive in order.
      expect(result).toEqual([1, 3]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('returns an empty array for empty input', async () => {
    const result = await mapWithConcurrency([], 4, async (n: number) => n);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildRepoSnapshotSafe
// ---------------------------------------------------------------------------

// Minimal raw repo payload that satisfies mapRepoMeta without any GitHub calls.
function makeRawRepo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    owner: { login: 'testowner' },
    name: 'test-repo',
    full_name: 'testowner/test-repo',
    html_url: 'https://github.com/testowner/test-repo',
    description: 'A test repository',
    topics: [],
    fork: false,
    archived: false,
    created_at: '2024-01-01T00:00:00Z',
    pushed_at: '2024-06-01T00:00:00Z',
    updated_at: '2024-06-01T00:00:00Z',
    default_branch: 'main',
    stargazers_count: 0,
    forks_count: 0,
    watchers_count: 0,
    open_issues_count: 0,
    size: 100,
    ...overrides,
  };
}

// Build a fake GitHubClient whose async methods all resolve with minimal data.
function makeFakeClient(): GitHubClient {
  return {
    getReadme: async () => null,
    getRecentCommits: async (): Promise<RawCommit[]> => [],
    getContributorsCount: async () => null,
    getReleaseAssets: async () => [],
    getCommitFiles: async (): Promise<string[]> => [],
    getTreePaths: async (): Promise<string[]> => [],
  } as unknown as GitHubClient;
}

describe('buildRepoSnapshotSafe', () => {
  it('returns a non-null snapshot for a well-formed repo and client', async () => {
    const client = makeFakeClient();
    const raw = makeRawRepo();
    const snapshot = await buildRepoSnapshotSafe(client, raw);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.fullName).toBe('testowner/test-repo');
  });

  it('filters non-string entries out of topics', async () => {
    const client = makeFakeClient();
    const raw = makeRawRepo({ topics: ['a', 123, null, 'b', { x: 1 }] });
    const snapshot = await buildRepoSnapshotSafe(client, raw);
    expect(snapshot?.topics).toEqual(['a', 'b']);
  });

  it('returns null when the underlying function throws', async () => {
    // Force a synchronous throw by providing a client whose method does not
    // return a thenable — buildRepoSnapshot awaits the result, so a method
    // that throws synchronously will cause the async function to reject.
    const throwingClient = {
      getReadme: () => { throw new Error('network exploded'); },
      getRecentCommits: () => { throw new Error('network exploded'); },
      getContributorsCount: () => { throw new Error('network exploded'); },
      getReleaseAssets: () => { throw new Error('network exploded'); },
      getCommitFiles: () => { throw new Error('network exploded'); },
      getTreePaths: () => { throw new Error('network exploded'); },
    } as unknown as GitHubClient;

    // Note: buildRepoSnapshot wraps each client call in .catch(), so async
    // rejections are swallowed internally. Synchronous throws inside a
    // Promise.all callback, however, cause Promise.all to reject, which
    // propagates to buildRepoSnapshot's caller. The safe wrapper catches that.
    const raw = makeRawRepo();
    const snapshot = await buildRepoSnapshotSafe(throwingClient, raw);
    expect(snapshot).toBeNull();
  });
});
