import type {
  AccountSnapshot,
  CommitInfo,
  RepoSnapshot,
} from '../engine/types.js';
import type { GitHubClient, RawCommit } from './client.js';

// Sentinel for an item whose callback rejected — kept distinct from any legit
// R (including null/undefined) so we can filter it out unambiguously.
const FAILED = Symbol('mapWithConcurrency.failed');

// Run async tasks with a bounded worker pool (protects the GitHub rate limit).
// allSettled-style: a single rejecting item is logged and dropped rather than
// aborting the whole batch and stranding its siblings. Successful results keep
// their input-relative order; callers already filter/flatten the output.
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: (R | typeof FAILED)[] = new Array(items.length).fill(FAILED);
  // A single shared iterator hands each worker the next [index, item] pair.
  // `.next()` is synchronous, so concurrent workers never collide on an item,
  // and `item` is typed as T (no out-of-bounds undefined to assert away).
  const queue = items.entries();

  async function worker(): Promise<void> {
    for (const [index, item] of queue) {
      try {
        results[index] = await fn(item, index);
      } catch (err) {
        console.warn(`mapWithConcurrency: item ${index} failed`, err);
        // Leave the FAILED sentinel; it is filtered out below.
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results.filter((r): r is R => r !== FAILED);
}

export function buildAccountSnapshot(
  raw: Record<string, unknown>,
  twoFactorEnabled: boolean | null,
): AccountSnapshot {
  return {
    login: String(raw.login ?? ''),
    type: raw.type === 'Organization' ? 'Organization' : 'User',
    name: (raw.name as string | null) ?? null,
    bio: (raw.bio as string | null) ?? null,
    company: (raw.company as string | null) ?? null,
    blog: (raw.blog as string | null) ?? null,
    email: (raw.email as string | null) ?? null,
    avatarUrl: String(raw.avatar_url ?? ''),
    htmlUrl: String(raw.html_url ?? ''),
    createdAt: String(raw.created_at ?? new Date(0).toISOString()),
    updatedAt: (raw.updated_at as string | null) ?? null,
    followers: Number(raw.followers ?? 0),
    following: Number(raw.following ?? 0),
    publicRepos: Number(raw.public_repos ?? 0),
    twoFactorEnabled,
  };
}

// Map the fields available on a repo object without extra API calls.
function mapRepoMeta(raw: Record<string, unknown>): Omit<
  RepoSnapshot,
  'readmeText' | 'recentCommits' | 'contributorsCount' | 'releaseAssets' | 'treePaths'
> {
  const owner =
    typeof raw.owner === 'object' && raw.owner
      ? String((raw.owner as Record<string, unknown>).login ?? '')
      : '';
  const name = String(raw.name ?? '');
  return {
    owner,
    name,
    fullName: String(raw.full_name ?? `${owner}/${name}`),
    htmlUrl: String(raw.html_url ?? ''),
    description: (raw.description as string | null) ?? null,
    topics: Array.isArray(raw.topics)
      ? raw.topics.filter((t): t is string => typeof t === 'string')
      : [],
    isFork: Boolean(raw.fork),
    isArchived: Boolean(raw.archived),
    createdAt: String(raw.created_at ?? new Date(0).toISOString()),
    pushedAt: (raw.pushed_at as string | null) ?? null,
    updatedAt: (raw.updated_at as string | null) ?? null,
    defaultBranch: String(raw.default_branch ?? 'main'),
    stargazers: Number(raw.stargazers_count ?? 0),
    forks: Number(raw.forks_count ?? 0),
    watchers: Number(raw.watchers_count ?? 0),
    openIssues: Number(raw.open_issues_count ?? 0),
    sizeKb: Number(raw.size ?? 0),
  };
}

function mapCommit(raw: RawCommit, changedFiles?: string[]): CommitInfo {
  return {
    sha: raw.sha,
    message: raw.commit?.message ?? '',
    authorName: raw.commit?.author?.name ?? 'unknown',
    authorLogin: raw.author?.login ?? null,
    authorDate: raw.commit?.author?.date ?? new Date(0).toISOString(),
    changedFiles,
  };
}

export interface BuildRepoOptions {
  // Deep scans also pull the file tree (to spot buried archives / loaders).
  // Default off for bulk account scans; on for single-repo deep scans.
  includeTree?: boolean;
  commitCount?: number;
}

// Enrich a repo object into a full RepoSnapshot. Tolerant of partial failures:
// a missing README or blocked endpoint degrades gracefully rather than aborting
// the whole scan.
export async function buildRepoSnapshot(
  client: GitHubClient,
  raw: Record<string, unknown>,
  opts: BuildRepoOptions = {},
): Promise<RepoSnapshot> {
  const meta = mapRepoMeta(raw);
  const commitCount = opts.commitCount ?? 5;

  const [readmeText, commits, contributorsCount, releaseAssets] = await Promise.all([
    client.getReadme(meta.owner, meta.name).catch(() => null),
    client.getRecentCommits(meta.owner, meta.name, commitCount).catch(() => [] as RawCommit[]),
    client.getContributorsCount(meta.owner, meta.name).catch(() => null),
    client.getReleaseAssets(meta.owner, meta.name).catch(() => []),
  ]);

  // Fetch changed files for the latest commit only (the rules need just that).
  let recentCommits: CommitInfo[] = commits.map((c) => mapCommit(c));
  if (commits.length > 0 && commits[0]) {
    const files = await client
      .getCommitFiles(meta.owner, meta.name, commits[0].sha)
      .catch(() => [] as string[]);
    recentCommits = commits.map((c, i) => mapCommit(c, i === 0 ? files : undefined));
  }

  let treePaths: string[] | undefined;
  if (opts.includeTree) {
    treePaths = await client
      .getTreePaths(meta.owner, meta.name, meta.defaultBranch)
      .catch(() => [] as string[]);
  }

  return {
    ...meta,
    readmeText,
    recentCommits,
    contributorsCount,
    releaseAssets,
    treePaths,
  };
}

// Tolerant wrapper: returns null if buildRepoSnapshot throws, so a single bad
// repo doesn't abort the entire account scan.
export async function buildRepoSnapshotSafe(
  client: GitHubClient,
  raw: Record<string, unknown>,
  opts: BuildRepoOptions = {},
): Promise<RepoSnapshot | null> {
  try {
    return await buildRepoSnapshot(client, raw, opts);
  } catch {
    return null;
  }
}
