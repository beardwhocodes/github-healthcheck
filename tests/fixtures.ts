import type {
  AccountSnapshot,
  CommitInfo,
  RepoSnapshot,
} from '../src/engine/types.js';

// A fixed "now" so all date math in tests is deterministic.
export const NOW = Date.parse('2026-06-19T00:00:00Z');

export function daysAgoIso(days: number, from: number = NOW): string {
  return new Date(from - days * 24 * 60 * 60 * 1000).toISOString();
}

export function commit(partial: Partial<CommitInfo> = {}): CommitInfo {
  return {
    sha: partial.sha ?? 'a'.repeat(40),
    message: partial.message ?? 'Add feature',
    authorName: partial.authorName ?? 'Real Dev',
    authorLogin: partial.authorLogin ?? 'realdev',
    authorDate: partial.authorDate ?? daysAgoIso(100),
    changedFiles: partial.changedFiles,
  };
}

// A clean, legitimate-looking repository. Override fields to construct the
// malicious variants the campaign uses.
export function repo(partial: Partial<RepoSnapshot> = {}): RepoSnapshot {
  const owner = partial.owner ?? 'realdev';
  const name = partial.name ?? 'awesome-lib';
  return {
    owner,
    name,
    fullName: partial.fullName ?? `${owner}/${name}`,
    htmlUrl: partial.htmlUrl ?? `https://github.com/${owner}/${name}`,
    description: partial.description ?? 'A genuinely useful library',
    topics: partial.topics ?? ['javascript', 'library'],
    isFork: partial.isFork ?? false,
    isArchived: partial.isArchived ?? false,
    createdAt: partial.createdAt ?? daysAgoIso(400),
    pushedAt: partial.pushedAt ?? daysAgoIso(100),
    updatedAt: partial.updatedAt ?? daysAgoIso(100),
    defaultBranch: partial.defaultBranch ?? 'main',
    stargazers: partial.stargazers ?? 12,
    forks: partial.forks ?? 3,
    watchers: partial.watchers ?? 12,
    openIssues: partial.openIssues ?? 1,
    sizeKb: partial.sizeKb ?? 800,
    readmeText: partial.readmeText ?? '# Awesome Lib\n\nInstall with npm. MIT licensed.',
    recentCommits: partial.recentCommits ?? [
      commit({ authorDate: daysAgoIso(100) }),
      commit({ authorDate: daysAgoIso(110), sha: 'b'.repeat(40) }),
    ],
    contributorsCount: partial.contributorsCount ?? 4,
    releaseAssets: partial.releaseAssets ?? [],
    treePaths: partial.treePaths,
  };
}

export function account(partial: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    login: partial.login ?? 'realdev',
    type: partial.type ?? 'User',
    name: partial.name ?? 'Real Dev',
    bio: partial.bio ?? 'I build things',
    company: partial.company ?? null,
    blog: partial.blog ?? null,
    email: partial.email ?? null,
    avatarUrl: partial.avatarUrl ?? 'https://avatars.githubusercontent.com/u/1',
    htmlUrl: partial.htmlUrl ?? 'https://github.com/realdev',
    createdAt: partial.createdAt ?? daysAgoIso(2000),
    updatedAt: partial.updatedAt ?? daysAgoIso(1),
    followers: partial.followers ?? 50,
    following: partial.following ?? 30,
    publicRepos: partial.publicRepos ?? 10,
    twoFactorEnabled: partial.twoFactorEnabled ?? null,
  };
}

// The canonical weaponized clone from the campaign: real code, untouched, with
// a single README-only "Update README.md" commit adding a password-protected
// download behind a shortener, plus a loader in the latest release.
export function weaponizedClone(): RepoSnapshot {
  return repo({
    owner: 'throwaway123',
    name: 'awesome-lib',
    fullName: 'throwaway123/awesome-lib',
    htmlUrl: 'https://github.com/throwaway123/awesome-lib',
    isFork: false,
    createdAt: daysAgoIso(5),
    pushedAt: daysAgoIso(0),
    contributorsCount: 6,
    readmeText: [
      '# Awesome Lib',
      '',
      '## Download',
      '[![Download](https://img.shields.io/badge/Download-Setup-blue)](https://bit.ly/3xfake)',
      '',
      'Get the full version free here: https://mega.nz/file/abc123 — Setup.zip',
      '',
      'Archive password: 2026',
    ].join('\n'),
    recentCommits: [
      commit({
        message: 'Update README.md',
        authorName: 'throwaway123',
        authorLogin: 'throwaway123',
        authorDate: daysAgoIso(0),
        changedFiles: ['README.md'],
      }),
      commit({
        message: 'Initial import',
        authorName: 'Real Dev',
        authorLogin: 'realdev',
        authorDate: daysAgoIso(400),
        sha: 'c'.repeat(40),
      }),
    ],
    releaseAssets: [
      { name: 'loader.exe', downloadUrl: 'https://example/loader.exe', sizeBytes: 4096 },
      { name: 'lua51.dll', downloadUrl: 'https://example/lua51.dll', sizeBytes: 2048 },
    ],
    treePaths: ['src/index.js', 'dist/deep/path/awesome-lib-1.0.0.zip'],
  });
}
