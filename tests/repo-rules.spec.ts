import { describe, expect, it } from 'vitest';

import {
  archiveBuriedDeep,
  clonedHistorySinglePusher,
  latestCommitOnlyReadme,
  notForkButDuplicateName,
  readmeDownloadBadgeToArchive,
  readmeDownloadLure,
  readmePasswordProtectedArchive,
  readmeReferencesArchive,
  readmeUrlShortener,
  staleCodeFreshReadme,
  suspiciousReleaseAsset,
  suspiciousTreePayload,
  trivialReadmeCommitMessage,
} from '../src/engine/rules/repo-rules.js';
import { NOW, commit, daysAgoIso, repo } from './fixtures.js';

const ctx = { now: NOW };

describe('readmeReferencesArchive', () => {
  it('flags a README that links to a .zip', () => {
    const f = readmeReferencesArchive(
      repo({ readmeText: 'Download here: https://host/Setup.zip' }),
      ctx,
    );
    expect(f).not.toBeNull();
    expect(f!.severity).toBe('medium');
    expect(f!.evidence?.some((e) => e.includes('.zip'))).toBe(true);
  });

  it('is quieter when an extension is only mentioned, not linked', () => {
    const f = readmeReferencesArchive(
      repo({ readmeText: 'We do not ship a .exe; build from source.' }),
      ctx,
    );
    expect(f).not.toBeNull();
    expect(f!.severity).toBe('low');
  });

  it('ignores a clean README', () => {
    expect(readmeReferencesArchive(repo({ readmeText: '# Lib\nnpm install lib' }), ctx)).toBeNull();
  });

  it('returns null when there is no README', () => {
    expect(readmeReferencesArchive(repo({ readmeText: null }), ctx)).toBeNull();
  });
});

describe('readmeDownloadBadgeToArchive', () => {
  it('flags a shields.io badge that links to an archive', () => {
    const readmeText =
      '[![Download](https://img.shields.io/badge/Get-Now-green)](https://host/app.zip)';
    const f = readmeDownloadBadgeToArchive(repo({ readmeText }), ctx);
    expect(f).not.toBeNull();
    expect(f!.severity).toBe('high');
  });

  it('does not flag a badge with no archive link', () => {
    const readmeText = '![build](https://img.shields.io/badge/build-passing-green)';
    expect(readmeDownloadBadgeToArchive(repo({ readmeText }), ctx)).toBeNull();
  });
});

describe('readmePasswordProtectedArchive', () => {
  it('flags an advertised archive password as critical', () => {
    const f = readmePasswordProtectedArchive(
      repo({ readmeText: 'Unzip Setup.zip. Archive password: 1234' }),
      ctx,
    );
    expect(f).not.toBeNull();
    expect(f!.severity).toBe('critical');
  });

  it('ignores prose that merely contains the word password', () => {
    expect(
      readmePasswordProtectedArchive(
        repo({ readmeText: 'This library hashes a user password securely.' }),
        ctx,
      ),
    ).toBeNull();
  });
});

describe('readmeUrlShortener', () => {
  it('flags bit.ly download links', () => {
    const f = readmeUrlShortener(repo({ readmeText: 'Get it: https://bit.ly/abc' }), ctx);
    expect(f).not.toBeNull();
    expect(f!.severity).toBe('high');
  });

  it('flags anonymous file hosts like mega.nz', () => {
    expect(
      readmeUrlShortener(repo({ readmeText: 'https://mega.nz/file/xyz' }), ctx),
    ).not.toBeNull();
  });

  it('does not flag github release links', () => {
    expect(
      readmeUrlShortener(
        repo({ readmeText: 'https://github.com/o/r/releases/download/v1/app.zip' }),
        ctx,
      ),
    ).toBeNull();
  });
});

describe('readmeDownloadLure', () => {
  it('flags "free download" + a binary together', () => {
    const f = readmeDownloadLure(
      repo({ readmeText: 'Free download of the full version: Setup.exe' }),
      ctx,
    );
    expect(f).not.toBeNull();
  });

  it('does not flag a lure phrase without any binary reference', () => {
    expect(
      readmeDownloadLure(repo({ readmeText: 'This template is free to use under MIT.' }), ctx),
    ).toBeNull();
  });
});

describe('latestCommitOnlyReadme', () => {
  it('flags a latest commit that only changed README.md', () => {
    const r = repo({
      recentCommits: [commit({ changedFiles: ['README.md'] }), commit({ sha: 'z'.repeat(40) })],
    });
    const f = latestCommitOnlyReadme(r, ctx);
    expect(f).not.toBeNull();
    expect(f!.severity).toBe('high');
  });

  it('does not flag a commit that changed code too', () => {
    const r = repo({ recentCommits: [commit({ changedFiles: ['README.md', 'src/x.js'] })] });
    expect(latestCommitOnlyReadme(r, ctx)).toBeNull();
  });

  it('is inconclusive (null) when changed files are unknown', () => {
    const r = repo({ recentCommits: [commit({ changedFiles: undefined })] });
    expect(latestCommitOnlyReadme(r, ctx)).toBeNull();
  });
});

describe('trivialReadmeCommitMessage', () => {
  it('flags "Update README.md"', () => {
    const r = repo({ recentCommits: [commit({ message: 'Update README.md' })] });
    expect(trivialReadmeCommitMessage(r, ctx)).not.toBeNull();
  });

  it('ignores trivial messages authored by a bot', () => {
    const r = repo({
      recentCommits: [commit({ message: 'Update README.md', authorName: 'dependabot[bot]' })],
    });
    expect(trivialReadmeCommitMessage(r, ctx)).toBeNull();
  });

  it('ignores a descriptive message', () => {
    const r = repo({ recentCommits: [commit({ message: 'Fix race in scheduler (#412)' })] });
    expect(trivialReadmeCommitMessage(r, ctx)).toBeNull();
  });
});

describe('staleCodeFreshReadme', () => {
  it('flags a long gap followed by a README-only bump', () => {
    const r = repo({
      recentCommits: [
        commit({ message: 'Update README.md', authorDate: daysAgoIso(1), changedFiles: ['README.md'] }),
        commit({ message: 'v1.0', authorDate: daysAgoIso(500), sha: 'd'.repeat(40) }),
      ],
    });
    expect(staleCodeFreshReadme(r, ctx)).not.toBeNull();
  });

  it('does not flag an actively developed repo', () => {
    const r = repo({
      recentCommits: [
        commit({ message: 'Update README.md', authorDate: daysAgoIso(1), changedFiles: ['README.md'] }),
        commit({ message: 'feature', authorDate: daysAgoIso(3), sha: 'e'.repeat(40) }),
      ],
    });
    expect(staleCodeFreshReadme(r, ctx)).toBeNull();
  });

  it('does not flag a long gap when the fresh commit is real code', () => {
    const r = repo({
      recentCommits: [
        commit({ message: 'Rewrite engine', authorDate: daysAgoIso(1), changedFiles: ['src/a.js'] }),
        commit({ message: 'v1.0', authorDate: daysAgoIso(500), sha: 'f'.repeat(40) }),
      ],
    });
    expect(staleCodeFreshReadme(r, ctx)).toBeNull();
  });
});

describe('clonedHistorySinglePusher', () => {
  it('flags inherited contributors with a single recent README editor', () => {
    const r = repo({
      contributorsCount: 8,
      recentCommits: [
        commit({ authorLogin: 'throwaway', authorName: 'throwaway', message: 'Update README.md', changedFiles: ['README.md'] }),
        commit({ authorLogin: 'throwaway', authorName: 'throwaway', message: 'Update README.md', sha: 'g'.repeat(40), changedFiles: ['README.md'] }),
      ],
    });
    expect(clonedHistorySinglePusher(r, ctx)).not.toBeNull();
  });

  it('does not flag a normal solo project with few contributors', () => {
    const r = repo({ contributorsCount: 1 });
    expect(clonedHistorySinglePusher(r, ctx)).toBeNull();
  });

  it('does not flag when recent commits span multiple authors', () => {
    const r = repo({
      contributorsCount: 8,
      recentCommits: [
        commit({ authorLogin: 'a', message: 'Update README.md', changedFiles: ['README.md'] }),
        commit({ authorLogin: 'b', message: 'Update README.md', sha: 'h'.repeat(40), changedFiles: ['README.md'] }),
      ],
    });
    expect(clonedHistorySinglePusher(r, ctx)).toBeNull();
  });
});

describe('suspiciousReleaseAsset', () => {
  it('flags loader.exe as critical', () => {
    const r = repo({
      releaseAssets: [{ name: 'loader.exe', downloadUrl: 'x', sizeBytes: 1 }],
    });
    const f = suspiciousReleaseAsset(r, ctx);
    expect(f).not.toBeNull();
    expect(f!.severity).toBe('critical');
  });

  it('flags lua51.dll', () => {
    const r = repo({ releaseAssets: [{ name: 'lua51.dll', downloadUrl: 'x', sizeBytes: 1 }] });
    expect(suspiciousReleaseAsset(r, ctx)).not.toBeNull();
  });

  it('ignores ordinary source archives', () => {
    const r = repo({ releaseAssets: [{ name: 'v1.0.0-source.tar.gz', downloadUrl: 'x', sizeBytes: 1 }] });
    // tar.gz is an archive, not an executable, so this rule stays quiet.
    expect(suspiciousReleaseAsset(r, ctx)).toBeNull();
  });
});

describe('suspiciousTreePayload', () => {
  it('flags a committed lua51.dll', () => {
    const r = repo({ treePaths: ['src/index.js', 'bin/lua51.dll'] });
    expect(suspiciousTreePayload(r, ctx)).not.toBeNull();
  });

  it('flags an Application.cmd launcher', () => {
    const r = repo({ treePaths: ['Application.cmd'] });
    expect(suspiciousTreePayload(r, ctx)).not.toBeNull();
  });
});

describe('archiveBuriedDeep', () => {
  it('flags a zip several directories deep', () => {
    const r = repo({ treePaths: ['dist/deep/path/app-1.0.0.zip'] });
    expect(archiveBuriedDeep(r, ctx)).not.toBeNull();
  });

  it('does not flag a top-level archive', () => {
    const r = repo({ treePaths: ['app.zip'] });
    expect(archiveBuriedDeep(r, ctx)).toBeNull();
  });
});

describe('notForkButDuplicateName', () => {
  it('flags an independent duplicate of a popular repo', () => {
    const r = repo({ owner: 'throwaway', fullName: 'throwaway/awesome-lib', isFork: false });
    const f = notForkButDuplicateName(r, {
      now: NOW,
      duplicateOfFullName: 'realdev/awesome-lib',
      duplicateOfStars: 5000,
    });
    expect(f).not.toBeNull();
  });

  it('does not flag a real fork', () => {
    const r = repo({ isFork: true });
    expect(
      notForkButDuplicateName(r, { now: NOW, duplicateOfFullName: 'realdev/awesome-lib' }),
    ).toBeNull();
  });
});
