import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitHubApiError, GitHubClient, isValidName } from '../src/github/client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

let client: GitHubClient;

beforeEach(() => {
  client = new GitHubClient('test-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// isValidName
// ---------------------------------------------------------------------------

describe('isValidName', () => {
  it('accepts plain alphanumeric owner names', () => {
    expect(isValidName('octocat')).toBe(true);
  });

  it('accepts names with dots, hyphens, and underscores', () => {
    expect(isValidName('a.b-c_d')).toBe(true);
  });

  it('rejects path traversal sequences', () => {
    expect(isValidName('../x')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidName('')).toBe(false);
  });

  it('rejects names containing a forward slash', () => {
    expect(isValidName('has/slash')).toBe(false);
  });

  it('rejects a 101-character name (over the 100-char limit)', () => {
    expect(isValidName('a'.repeat(101))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting: 403/429 with x-ratelimit-remaining: 0 → GitHubApiError(429)
// ---------------------------------------------------------------------------

describe('rate limit handling', () => {
  it('throws GitHubApiError with status 429 on 403 + remaining=0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeResponse({}, 403, { 'x-ratelimit-remaining': '0' }),
      ),
    );

    await expect(client.getAuthenticatedUser()).rejects.toMatchObject({
      status: 429,
      name: 'GitHubApiError',
    });
  });

  it('throws GitHubApiError with status 429 on 429 + remaining=0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeResponse({}, 429, { 'x-ratelimit-remaining': '0' }),
      ),
    );

    await expect(client.getAuthenticatedUser()).rejects.toMatchObject({
      status: 429,
      name: 'GitHubApiError',
    });
  });

  it('does NOT throw on 403 when remaining is non-zero', async () => {
    // A 403 with remaining > 0 is a plain auth/permission error, not rate limit.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeResponse({ message: 'Forbidden' }, 403, {
          'x-ratelimit-remaining': '50',
        }),
      ),
    );

    // Should reject with a regular error (not 429) — the caller may handle it.
    await expect(client.getAuthenticatedUser()).rejects.toMatchObject({
      status: 403,
    });
  });
});

// ---------------------------------------------------------------------------
// Retry / backoff for transient failures (5xx + secondary rate limits)
// ---------------------------------------------------------------------------

describe('retry / backoff', () => {
  // Inject a no-op sleep so backoff adds no real delay; capture the requested
  // delays to assert Retry-After is honored.
  function makeRetryClient(): { client: GitHubClient; delays: number[] } {
    const delays: number[] = [];
    const client = new GitHubClient('test-token', {
      maxRetries: 2,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    return { client, delays };
  }

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('retries a 500 then succeeds', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ message: 'boom' }, 500))
      .mockResolvedValueOnce(makeResponse({ login: 'octocat' }));
    vi.stubGlobal('fetch', mockFetch);

    const { client } = makeRetryClient();
    const result = await client.getAuthenticatedUser();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ login: 'octocat' });
  });

  it('retries a secondary rate limit (403 + Retry-After) and honors the delay', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({ message: 'secondary limit' }, 403, {
          'x-ratelimit-remaining': '50',
          'retry-after': '3',
        }),
      )
      .mockResolvedValueOnce(makeResponse({ login: 'octocat' }));
    vi.stubGlobal('fetch', mockFetch);

    const { client, delays } = makeRetryClient();
    const result = await client.getAuthenticatedUser();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ login: 'octocat' });
    expect(delays).toEqual([3000]); // Retry-After: 3s
  });

  it('gives up after the bounded retry cap and surfaces the error', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse({ message: 'down' }, 503));
    vi.stubGlobal('fetch', mockFetch);

    const { client } = makeRetryClient();
    await expect(client.getAuthenticatedUser()).rejects.toMatchObject({
      status: 503,
      name: 'GitHubApiError',
    });
    // maxRetries=2 → one initial attempt plus two retries.
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a plain 403 with no Retry-After', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeResponse({ message: 'Forbidden' }, 403, { 'x-ratelimit-remaining': '50' }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const { client } = makeRetryClient();
    await expect(client.getAuthenticatedUser()).rejects.toMatchObject({ status: 403 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Path-segment validation + encoding (SSRF hardening, enforced in-client)
// ---------------------------------------------------------------------------

describe('path-segment validation', () => {
  it('rejects an invalid owner before issuing any request', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    await expect(client.getRepo('../etc', 'repo')).rejects.toMatchObject({
      status: 400,
      name: 'GitHubApiError',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects an invalid login passed to getUser', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    await expect(client.getUser('has/slash')).rejects.toMatchObject({ status: 400 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('passes valid names through unchanged (encoding is a no-op)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse({ id: 1 }));
    vi.stubGlobal('fetch', mockFetch);

    await client.getRepo('a.b-c_d', 'repo');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/a.b-c_d/repo',
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// getReleaseAssets cap
// ---------------------------------------------------------------------------

describe('getReleaseAssets', () => {
  it('caps the number of returned assets', async () => {
    const assets = Array.from({ length: 6 }, (_v, i) => ({
      name: `asset-${i}`,
      browser_download_url: `https://example.com/asset-${i}`,
      size: 100,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse([{ assets }])),
    );

    const result = await client.getReleaseAssets('owner', 'repo', 2);
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.name)).toEqual(['asset-0', 'asset-1']);
  });
});

// ---------------------------------------------------------------------------
// getReadme
// ---------------------------------------------------------------------------

describe('getReadme', () => {
  it('returns null on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse({ message: 'Not Found' }, 404)),
    );

    const result = await client.getReadme('owner', 'repo');
    expect(result).toBeNull();
  });

  it('decodes base64 content when encoding is base64', async () => {
    const original = 'Hello, README!';
    // btoa works on plain ASCII
    const encoded = btoa(original);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeResponse({ content: encoded, encoding: 'base64' }),
      ),
    );

    const result = await client.getReadme('owner', 'repo');
    expect(result).toBe(original);
  });

  it('truncates decoded content to 256*1024 characters', async () => {
    const README_MAX_CHARS = 256 * 1024;
    // Build a string longer than the cap and base64-encode it
    const longText = 'x'.repeat(README_MAX_CHARS + 1000);
    const encoded = btoa(longText);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeResponse({ content: encoded, encoding: 'base64' }),
      ),
    );

    const result = await client.getReadme('owner', 'repo');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(README_MAX_CHARS);
  });

  it('returns the raw content string when encoding is not base64', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeResponse({ content: 'raw text', encoding: 'utf-8' }),
      ),
    );

    const result = await client.getReadme('owner', 'repo');
    expect(result).toBe('raw text');
  });
});

// ---------------------------------------------------------------------------
// getRecentCommits
// ---------------------------------------------------------------------------

describe('getRecentCommits', () => {
  it('returns empty array on 409 (empty/uninitialized repo)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse({ message: 'Git Repository is empty.' }, 409)),
    );

    const result = await client.getRecentCommits('owner', 'repo');
    expect(result).toEqual([]);
  });

  it('returns empty array on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse({ message: 'Not Found' }, 404)),
    );

    const result = await client.getRecentCommits('owner', 'repo');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getContributorsCount
// ---------------------------------------------------------------------------

describe('getContributorsCount', () => {
  it('parses page number from link header rel="last"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ login: 'user1' }]), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            link:
              '<https://api.github.com/repos/owner/repo/contributors?per_page=1&page=42>; rel="last"',
          },
        }),
      ),
    );

    const result = await client.getContributorsCount('owner', 'repo');
    expect(result).toBe(42);
  });

  it('falls back to data.length when there is no link header', async () => {
    const contributors = [{ login: 'user1' }, { login: 'user2' }, { login: 'user3' }];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse(contributors)),
    );

    const result = await client.getContributorsCount('owner', 'repo');
    expect(result).toBe(3);
  });

  it('returns null on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse({ message: 'Not Found' }, 404)),
    );

    const result = await client.getContributorsCount('owner', 'repo');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listRepos
// ---------------------------------------------------------------------------

describe('listRepos', () => {
  it('paginates: fetches page 2 when page 1 is full, stops when page 2 is short', async () => {
    const perPage = 2;

    const page1 = [{ id: 1, name: 'repo1' }, { id: 2, name: 'repo2' }];
    const page2 = [{ id: 3, name: 'repo3' }]; // shorter than perPage → stop

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(page1))
      .mockResolvedValueOnce(makeResponse(page2));

    vi.stubGlobal('fetch', mockFetch);

    const result = await client.listRepos({
      login: 'someuser',
      self: false,
      perPage,
      maxPages: 5,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('stops at maxPages even if pages are full', async () => {
    const perPage = 2;
    const fullPage = [{ id: 1, name: 'r1' }, { id: 2, name: 'r2' }];

    // Each call needs a fresh Response instance — bodies can only be read once.
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(makeResponse(fullPage)),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.listRepos({
      login: 'someuser',
      self: false,
      perPage,
      maxPages: 2,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(4);
  });
});
