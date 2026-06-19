import { buildCloneMatch, evaluateRepo } from '../engine/evaluate.js';
import type { CloneMatch, RepoSnapshot } from '../engine/types.js';
import { GitHubClient } from './client.js';
import { buildRepoSnapshot, mapWithConcurrency } from './snapshot.js';

export interface CloneScanOptions {
  now: number;
  // Max same-name candidates to inspect per source repo.
  maxCandidates?: number;
  // Only return matches at or above this confidence.
  minConfidence?: number;
}

// Find suspected malicious clones of a single source repo elsewhere on GitHub.
export async function findClonesForRepo(
  client: GitHubClient,
  source: { owner: string; fullName: string; description: string | null; stargazers: number },
  opts: CloneScanOptions,
): Promise<CloneMatch[]> {
  const maxCandidates = opts.maxCandidates ?? 8;
  const minConfidence = opts.minConfidence ?? 35;
  const repoName = source.fullName.split('/')[1] ?? '';
  if (!repoName) return [];

  // Same name, anywhere, not owned by the source owner.
  let items: Record<string, unknown>[];
  try {
    items = await client.searchRepos(`${repoName} in:name`, 20);
  } catch {
    return [];
  }

  const candidates = items
    .filter((it) => {
      const fullName = String(it.full_name ?? '').toLowerCase();
      const name = String(it.name ?? '').toLowerCase();
      const ownerLogin = String(
        (it.owner as Record<string, unknown> | undefined)?.login ?? '',
      ).toLowerCase();
      return (
        name === repoName.toLowerCase() &&
        fullName !== source.fullName.toLowerCase() &&
        ownerLogin !== source.owner.toLowerCase()
      );
    })
    .slice(0, maxCandidates);

  const matches = await mapWithConcurrency(candidates, 3, async (raw) => {
    let snapshot: RepoSnapshot;
    try {
      snapshot = await buildRepoSnapshot(client, raw, { includeTree: true });
    } catch {
      return null;
    }
    const report = evaluateRepo(snapshot, {
      now: opts.now,
      duplicateOfFullName: source.fullName,
      duplicateOfStars: source.stargazers,
    });
    const match = buildCloneMatch({
      sourceRepo: source.fullName,
      suspect: snapshot,
      report,
      signals: {
        sameName: true,
        sameDescription:
          !!source.description &&
          source.description.trim().length > 0 &&
          snapshot.description?.trim() === source.description.trim(),
        suspectIsFork: snapshot.isFork,
        suspectStars: snapshot.stargazers,
        sourceStars: source.stargazers,
        differentOwner: true,
      },
    });
    return match.confidence >= minConfidence ? match : null;
  });

  return matches
    .filter((m): m is CloneMatch => m !== null)
    .sort((a, b) => b.confidence - a.confidence);
}

// Scan several source repos for clones (used by the on-demand route). The same
// suspect repo can surface for more than one source; keep the highest-confidence
// match per suspect so the report has no duplicate rows.
export async function findClonesForRepos(
  client: GitHubClient,
  sources: { owner: string; fullName: string; description: string | null; stargazers: number }[],
  opts: CloneScanOptions,
): Promise<CloneMatch[]> {
  const perRepo = await mapWithConcurrency(sources, 2, (source) =>
    findClonesForRepo(client, source, opts),
  );

  const bySuspect = new Map<string, CloneMatch>();
  for (const match of perRepo.flat()) {
    const key = match.suspectRepo.toLowerCase();
    const existing = bySuspect.get(key);
    if (!existing || match.confidence > existing.confidence) {
      bySuspect.set(key, match);
    }
  }

  return [...bySuspect.values()].sort((a, b) => b.confidence - a.confidence);
}
