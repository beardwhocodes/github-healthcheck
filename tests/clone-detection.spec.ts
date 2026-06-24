import { describe, expect, it } from 'vitest';

import {
  findClonesForRepo,
  findClonesForRepos,
} from '../src/github/clone-detection.js';
import type { GitHubClient } from '../src/github/client.js';
import type { RepoSnapshot } from '../src/engine/types.js';
import { NOW, repo } from './fixtures.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Minimal RepoSnapshot that scores 0 / band="safe" — no malware signals.
function benignSnapshot(owner: string, name: string): RepoSnapshot {
  return repo({ owner, name, fullName: `${owner}/${name}` });
}

// A raw search result item (as GitHub API returns).
function rawItem(owner: string, name: string): Record<string, unknown> {
  return {
    full_name: `${owner}/${name}`,
    name,
    owner: { login: owner },
    description: null,
    fork: false,
    archived: false,
    created_at: new Date(NOW - 30 * 86400 * 1000).toISOString(),
    pushed_at: new Date(NOW - 1 * 86400 * 1000).toISOString(),
    updated_at: new Date(NOW - 1 * 86400 * 1000).toISOString(),
    default_branch: 'main',
    stargazers_count: 0,
    forks_count: 0,
    watchers_count: 0,
    open_issues_count: 0,
    size: 100,
    html_url: `https://github.com/${owner}/${name}`,
    topics: [],
  };
}

// Build a fake GitHubClient that returns controlled values.
// Each snapshot method is a no-op that returns a safe default.
function makeFakeClient(opts: {
  searchResults: Record<string, unknown>[];
  // Optional: override the snapshot produced for a given full_name
  snapshotOverrides?: Record<string, RepoSnapshot>;
}): GitHubClient {
  const snapshotFor = (owner: string, name: string): RepoSnapshot => {
    const key = `${owner}/${name}`;
    return opts.snapshotOverrides?.[key] ?? benignSnapshot(owner, name);
  };

  // buildRepoSnapshot is called internally; we override each client method it
  // uses so the real snapshot builder gets clean canned data.
  return {
    searchRepos: async () => opts.searchResults,
    getReadme: async (owner: string, name: string) =>
      snapshotFor(owner, name).readmeText,
    getRecentCommits: async (owner: string, name: string) => {
      const snap = snapshotFor(owner, name);
      // Return commits in raw API shape (client → snapshot maps them).
      return snap.recentCommits.map((c) => ({
        sha: c.sha,
        commit: {
          message: c.message,
          author: { name: c.authorName, date: c.authorDate },
        },
        author: c.authorLogin ? { login: c.authorLogin } : null,
      }));
    },
    getContributorsCount: async (owner: string, name: string) =>
      snapshotFor(owner, name).contributorsCount,
    getReleaseAssets: async (owner: string, name: string) =>
      snapshotFor(owner, name).releaseAssets,
    getCommitFiles: async () => [],
    getTreePaths: async (owner: string, name: string) =>
      snapshotFor(owner, name).treePaths ?? [],
    // Other methods not needed for clone-detection:
    getAuthenticatedUser: async () => ({}),
    getUser: async () => ({}),
    listRepos: async () => [],
    getRepo: async () => ({}),
  } as unknown as GitHubClient;
}

// Source repo used throughout.
const SOURCE = {
  owner: 'realdev',
  fullName: 'realdev/awesome-lib',
  description: 'A genuinely useful library',
  stargazers: 100,
};

// ---------------------------------------------------------------------------
// findClonesForRepo — candidate filtering
// ---------------------------------------------------------------------------

describe('findClonesForRepo — candidate filtering', () => {
  it('excludes a search result that IS the source repo itself', async () => {
    const client = makeFakeClient({
      searchResults: [
        rawItem('realdev', 'awesome-lib'), // same owner, same name = source itself
        rawItem('attacker', 'awesome-lib'), // legitimate candidate
      ],
    });

    const results = await findClonesForRepo(client, SOURCE, {
      now: NOW,
      minConfidence: 0, // accept any score so we can count candidates evaluated
    });

    // Only the attacker candidate can appear; the source itself must be excluded.
    for (const m of results) {
      expect(m.suspectRepo).not.toBe('realdev/awesome-lib');
    }
  });

  it('excludes a result owned by the source owner (even if name differs slightly)', async () => {
    const client = makeFakeClient({
      searchResults: [
        rawItem('realdev', 'awesome-lib'), // same owner
        rawItem('attacker', 'awesome-lib'),
      ],
    });

    const results = await findClonesForRepo(client, SOURCE, {
      now: NOW,
      minConfidence: 0,
    });

    for (const m of results) {
      expect(m.suspectOwner).not.toBe('realdev');
    }
  });

  it('excludes a result whose name does not match the source repo name', async () => {
    const client = makeFakeClient({
      searchResults: [
        rawItem('attacker', 'awesome-lib-fork'), // different name
        rawItem('attacker2', 'awesome-lib'), // correct name
      ],
    });

    const results = await findClonesForRepo(client, SOURCE, {
      now: NOW,
      minConfidence: 0,
    });

    for (const m of results) {
      expect(m.suspectRepo).not.toContain('awesome-lib-fork');
    }
  });

  it('honors maxCandidates by slicing before evaluation', async () => {
    // Provide 5 valid candidates but cap at 2.
    const manyResults = [
      rawItem('a1', 'awesome-lib'),
      rawItem('a2', 'awesome-lib'),
      rawItem('a3', 'awesome-lib'),
      rawItem('a4', 'awesome-lib'),
      rawItem('a5', 'awesome-lib'),
    ];

    const client = makeFakeClient({ searchResults: manyResults });

    const results = await findClonesForRepo(client, SOURCE, {
      now: NOW,
      minConfidence: 0,
      maxCandidates: 2,
    });

    // At most 2 candidates could have been evaluated, so at most 2 results.
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('applies minConfidence gate and excludes low scorers', async () => {
    // A benign snapshot (no malware signals, no description copy) produces a
    // structural-only confidence that gets capped at 20 by evaluate logic.
    const client = makeFakeClient({
      searchResults: [rawItem('attacker', 'awesome-lib')],
    });

    const results = await findClonesForRepo(client, SOURCE, {
      now: NOW,
      minConfidence: 35, // above the structural-only cap of 20
    });

    expect(results).toHaveLength(0);
  });

  it('returns an empty array when repoName is empty', async () => {
    const noNameSource = { ...SOURCE, fullName: '' };
    const client = makeFakeClient({ searchResults: [] });

    const results = await findClonesForRepo(client, noNameSource, { now: NOW });
    expect(results).toEqual([]);
  });

  it('returns empty array gracefully when searchRepos throws', async () => {
    const client = {
      searchRepos: async () => {
        throw new Error('network error');
      },
    } as unknown as GitHubClient;

    const results = await findClonesForRepo(client, SOURCE, { now: NOW });
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findClonesForRepos — deduplication by suspect
// ---------------------------------------------------------------------------

describe('findClonesForRepos — deduplicate by suspect', () => {
  it('keeps only the highest-confidence instance when the same suspect appears for two sources', async () => {
    // Two source repos that both lead to the same suspect "attacker/awesome-lib".
    // We'll give one source a description match (higher confidence) and the
    // other no description match (lower confidence).

    const sourceA = {
      owner: 'realdev',
      fullName: 'realdev/awesome-lib',
      description: 'A genuinely useful library',
      stargazers: 100,
    };

    const sourceB = {
      owner: 'realdev',
      fullName: 'realdev/other-lib',
      description: null,
      stargazers: 50,
    };

    // Suspect snapshot: copies sourceA's description.
    const suspectSnap = repo({
      owner: 'attacker',
      name: 'awesome-lib',
      fullName: 'attacker/awesome-lib',
      description: 'A genuinely useful library', // matches sourceA
      stargazers: 1,
    });

    // For sourceB's search we must return a different-named suspect to avoid
    // the name filter removing it; here attacker/other-lib.
    const suspectSnapB = benignSnapshot('attacker', 'other-lib');

    // For sourceA search → returns attacker/awesome-lib (high confidence).
    // For sourceB search → returns a different suspect (no overlap).
    // We'll test that when BOTH searches return attacker/awesome-lib, the map
    // keeps only the higher-confidence entry.

    // Build a client that always returns the same suspect for any search.
    const attackerRaw = rawItem('attacker', 'awesome-lib');

    const client = makeFakeClient({
      searchResults: [attackerRaw],
      snapshotOverrides: {
        'attacker/awesome-lib': suspectSnap,
        'attacker/other-lib': suspectSnapB,
      },
    });

    // Source A: name matches, description matches → higher confidence.
    // Source B: name 'other-lib' != 'awesome-lib', so the candidate is filtered
    // out. Let's instead confirm deduplication by running two separate sources
    // that both find the same suspect.

    // Override searchRepos to always return attacker/awesome-lib regardless.
    // To do that, produce a client whose searchRepos returns the suspect for BOTH
    // source repos (including when the source is sourceB / name=other-lib — we
    // skip the per-name filter concern here by making the name match).

    const sourceBSameName = {
      owner: 'realdev2',
      fullName: 'realdev2/awesome-lib',
      description: null, // no description → lower confidence for this source
      stargazers: 10,
    };

    const clientBoth = makeFakeClient({
      searchResults: [attackerRaw],
      snapshotOverrides: { 'attacker/awesome-lib': suspectSnap },
    });

    // sourceA finds attacker/awesome-lib with description match → high confidence
    // sourceBSameName finds it without description match → lower confidence
    const results = await findClonesForRepos(
      clientBoth,
      [sourceA, sourceBSameName],
      { now: NOW, minConfidence: 0 },
    );

    // The same suspect must appear exactly once.
    const suspectEntries = results.filter(
      (m) => m.suspectRepo === 'attacker/awesome-lib',
    );
    expect(suspectEntries).toHaveLength(1);

    // It must be the higher-confidence one (from sourceA, which copies the description).
    expect(suspectEntries[0]!.sourceRepo).toBe('realdev/awesome-lib');
  });

  it('returns one entry per distinct suspect when there is no overlap', async () => {
    const sourceA = {
      owner: 'realdev',
      fullName: 'realdev/awesome-lib',
      description: null,
      stargazers: 50,
    };
    const sourceB = {
      owner: 'realdev',
      fullName: 'realdev/other-lib',
      description: null,
      stargazers: 50,
    };

    let callCount = 0;
    const fakeClient = {
      searchRepos: async (_q: string) => {
        callCount++;
        if (callCount === 1) return [rawItem('attacker1', 'awesome-lib')];
        return [rawItem('attacker2', 'other-lib')];
      },
      getReadme: async () => null,
      getRecentCommits: async () => [],
      getContributorsCount: async () => null,
      getReleaseAssets: async () => [],
      getCommitFiles: async () => [],
      getTreePaths: async () => [],
    } as unknown as GitHubClient;

    const results = await findClonesForRepos(fakeClient, [sourceA, sourceB], {
      now: NOW,
      minConfidence: 0,
    });

    const suspects = results.map((m) => m.suspectRepo);
    // No duplicates in output.
    expect(new Set(suspects).size).toBe(suspects.length);
  });
});
