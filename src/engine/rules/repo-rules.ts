import {
  ARCHIVE_EXTENSIONS,
  BADGE_HOSTS,
  BINARY_EXTENSIONS,
  DOWNLOAD_LURE_PATTERNS,
  EXECUTABLE_EXTENSIONS,
  PASSWORD_ARCHIVE_PATTERNS,
  PAYLOAD_FILENAME_PATTERNS,
  SUSPICIOUS_PAYLOAD_NAMES,
  THRESHOLDS,
  TRIVIAL_COMMIT_MESSAGES,
  URL_SHORTENERS,
  WEIGHTS,
} from '../constants.js';
import {
  clip,
  extractUrls,
  findBinaryFilenameTokens,
  hasExtension,
  hostnameOf,
  hoursBetween,
  isBotAuthor,
  urlHasExtension,
} from '../helpers.js';
import type { Finding, RepoSnapshot } from '../types.js';

export interface RepoRuleContext {
  now: number;
  // When evaluating a suspected clone: the stars/name of the upstream it copies.
  duplicateOfFullName?: string;
  duplicateOfStars?: number;
}

export type RepoRule = (repo: RepoSnapshot, ctx: RepoRuleContext) => Finding | null;

const README_FILE = /^readme(\.md|\.rst|\.txt)?$/i;

// 1. README links to a binary/archive, or names a binary file. Low on its own,
//    but the campaign's weaponized READMEs always reference the payload archive.
//    Boundary-aware: a plain "github.com" link or English prose does NOT match —
//    we look for URLs whose PATH ends in a binary extension, or real filename
//    tokens like "Setup.exe"/"app-1.0.zip".
export const readmeReferencesArchive: RepoRule = (repo) => {
  if (!repo.readmeText) return null;

  const archiveUrls = extractUrls(repo.readmeText).filter((u) =>
    urlHasExtension(u, BINARY_EXTENSIONS),
  );
  const fileTokens = findBinaryFilenameTokens(repo.readmeText);
  if (archiveUrls.length === 0 && fileTokens.length === 0) return null;

  const linked = archiveUrls.length > 0;
  return {
    id: 'readme-references-archive',
    title: 'README references a downloadable binary/archive',
    severity: linked ? 'medium' : 'low',
    detail:
      'The README points readers at a binary or archive file. In the malware ' +
      'campaign, cloned repos keep the original code untouched and only add a ' +
      'link to a ZIP that contains the trojan loader.',
    remediation:
      'If this is not your repo, do not download the archive. If it is yours, ' +
      'confirm you added these references and that they point where you expect.',
    evidence: [
      ...(fileTokens.length > 0 ? [`files: ${fileTokens.slice(0, 3).join(', ')}`] : []),
      ...archiveUrls.slice(0, 3).map((u) => `link: ${clip(u)}`),
    ],
    weight: WEIGHTS.readmeReferencesArchive,
  };
};

// 2. README leans on download *badges* (shields.io) that resolve to an archive
//    OR to a shortener/file host (the campaign points the badge at bit.ly /
//    mega.nz just as often as a direct ZIP).
export const readmeDownloadBadgeToArchive: RepoRule = (repo) => {
  if (!repo.readmeText) return null;
  const urls = extractUrls(repo.readmeText);
  const hasBadge = urls.some((u) => {
    const host = hostnameOf(u);
    return host !== null && BADGE_HOSTS.some((b) => host === b || host.endsWith(`.${b}`));
  });
  if (!hasBadge) return null;

  const archiveLinks = urls.filter((u) => urlHasExtension(u, ARCHIVE_EXTENSIONS));
  const hostedLinks = urls.filter((u) => {
    const host = hostnameOf(u);
    return host !== null && URL_SHORTENERS.some((s) => host === s || host.endsWith(`.${s}`));
  });
  const targets = [...archiveLinks, ...hostedLinks];
  if (targets.length === 0) return null;

  return {
    id: 'readme-download-badge',
    title: 'README uses download badges pointing at a payload',
    severity: 'high',
    detail:
      'Weaponized clones replace real documentation with prominent download ' +
      'badges (shields.io) and colored buttons that all funnel to the same ZIP ' +
      'or to a shortener/file host hiding it.',
    remediation: 'Treat the download as untrusted; inspect the archive in a sandbox, not on your machine.',
    evidence: targets.slice(0, 3).map((u) => `target: ${clip(u)}`),
    weight: WEIGHTS.readmeDownloadBadgeToArchive,
  };
};

// 3. README advertises a password-protected archive (defeats AV / VirusTotal).
export const readmePasswordProtectedArchive: RepoRule = (repo) => {
  if (!repo.readmeText) return null;
  const matched = PASSWORD_ARCHIVE_PATTERNS.filter((re) => re.test(repo.readmeText!));
  if (matched.length === 0) return null;

  const lines = repo.readmeText
    .split('\n')
    .filter((line) => PASSWORD_ARCHIVE_PATTERNS.some((re) => re.test(line)))
    .slice(0, 2)
    .map((line) => `“${clip(line, 80)}”`);

  return {
    id: 'readme-password-archive',
    title: 'README describes a password-protected archive',
    severity: 'critical',
    detail:
      'A password on the download is a deliberate evasion: it stops antivirus ' +
      'and VirusTotal from inspecting the contents until a human extracts it. ' +
      'Legitimate open-source projects almost never ship password-locked builds.',
    remediation: 'Do not extract or run this. Password-locked "builds" in a code repo are a near-certain malware tell.',
    evidence: lines,
    weight: WEIGHTS.readmePasswordProtectedArchive,
  };
};

// 4. README hides the real destination behind a URL shortener / file host.
export const readmeUrlShortener: RepoRule = (repo) => {
  if (!repo.readmeText) return null;
  const hits = extractUrls(repo.readmeText).filter((u) => {
    const host = hostnameOf(u);
    return host !== null && URL_SHORTENERS.some((s) => host === s || host.endsWith(`.${s}`));
  });
  if (hits.length === 0) return null;

  return {
    id: 'readme-url-shortener',
    title: 'README hides downloads behind a shortener / file host',
    severity: 'high',
    detail:
      'Shorteners and anonymous file hosts (mega.nz, mediafire, gofile, t.me) ' +
      'conceal the final payload URL and let the attacker swap it after the ' +
      'fact. Trustworthy releases link to GitHub Releases, not bit.ly.',
    remediation: 'Do not follow shortened download links from a code repository.',
    evidence: hits.slice(0, 3).map((u) => `link: ${clip(u)}`),
    weight: WEIGHTS.readmeUrlShortener,
  };
};

// 5. README uses cracked/free-download social-engineering lures.
export const readmeDownloadLure: RepoRule = (repo) => {
  if (!repo.readmeText) return null;
  const matched = DOWNLOAD_LURE_PATTERNS.filter((re) => re.test(repo.readmeText!));
  if (matched.length < 1) return null;
  // Require a REAL binary reference too (an archive link or a filename token),
  // so "free to use" or "Download the docs" in a legitimate project — or a bare
  // github.com link — doesn't trip this.
  const hasBinary =
    extractUrls(repo.readmeText).some((u) => urlHasExtension(u, BINARY_EXTENSIONS)) ||
    findBinaryFilenameTokens(repo.readmeText).length > 0;
  if (!hasBinary) return null;

  const phrases = repo.readmeText
    .split('\n')
    .filter((line) => DOWNLOAD_LURE_PATTERNS.some((re) => re.test(line)))
    .slice(0, 2)
    .map((line) => `“${clip(line, 80)}”`);

  return {
    id: 'readme-download-lure',
    title: 'README uses "free / cracked / full version" download lures',
    severity: 'high',
    detail:
      'Pirated-software and "free download" framing next to a binary is a ' +
      'classic bait used to get victims to run the attached loader.',
    evidence: phrases,
    weight: WEIGHTS.readmeDownloadLure,
  };
};

// 6. The latest commit changed ONLY the README. The single clearest tell of a
//    weaponized clone (git-malware-finder's `onlyReadme`).
export const latestCommitOnlyReadme: RepoRule = (repo) => {
  const latest = repo.recentCommits[0];
  if (!latest || !latest.changedFiles || latest.changedFiles.length === 0) return null;
  const onlyReadme =
    latest.changedFiles.length === 1 && README_FILE.test(latest.changedFiles[0]!.split('/').pop() ?? '');
  if (!onlyReadme) return null;

  return {
    id: 'latest-commit-only-readme',
    title: 'Most recent change touches only the README',
    severity: 'high',
    detail:
      'The newest commit modified nothing but the README. Attackers clone a ' +
      'real project untouched and make a single README-only commit to insert ' +
      'the download link — exactly this pattern.',
    remediation: 'Verify you made this change. A README-only latest commit on inherited code is the signature of this campaign.',
    evidence: [`changed: ${latest.changedFiles.join(', ')}`, `message: “${clip(latest.message, 60)}”`],
    weight: WEIGHTS.latestCommitOnlyReadme,
  };
};

// 7. The latest commit message is a generic "Update README.md".
export const trivialReadmeCommitMessage: RepoRule = (repo) => {
  const latest = repo.recentCommits[0];
  if (!latest) return null;
  if (isBotAuthor(latest.authorName)) return null;
  const message = latest.message.split('\n')[0]?.trim() ?? '';
  if (!TRIVIAL_COMMIT_MESSAGES.some((re) => re.test(message))) return null;

  return {
    id: 'trivial-readme-commit-message',
    title: 'Latest commit message is a generic "Update README.md"',
    severity: 'medium',
    detail:
      'Across the campaign, the most recent commit in every malicious clone was ' +
      'literally named "Update README.md" with no substantive code change.',
    evidence: [`message: “${clip(message, 60)}”`, `author: ${latest.authorName}`],
    weight: WEIGHTS.trivialReadmeCommitMessage,
  };
};

// 8. Code is months/years old but the README was just bumped.
export const staleCodeFreshReadme: RepoRule = (repo) => {
  if (repo.recentCommits.length < 2) return null;
  const [latest, previous] = repo.recentCommits;
  const gapHours = hoursBetween(latest!.authorDate, previous!.authorDate);
  if (gapHours < THRESHOLDS.staleCodeGapHours) return null;

  // Only meaningful if the fresh commit looks like a README touch.
  const latestMessage = latest!.message.split('\n')[0]?.trim() ?? '';
  const looksLikeReadme =
    TRIVIAL_COMMIT_MESSAGES.some((re) => re.test(latestMessage)) ||
    (latest!.changedFiles?.every((f) => README_FILE.test(f.split('/').pop() ?? '')) ?? false);
  if (!looksLikeReadme) return null;

  const gapDays = Math.round(gapHours / 24);
  return {
    id: 'stale-code-fresh-readme',
    title: 'Dormant codebase, suddenly-updated README',
    severity: 'high',
    detail:
      `The codebase sat untouched for ~${gapDays} days before a fresh ` +
      'README-only update. A long gap followed by a lone README change is how ' +
      'attackers re-activate a dormant clone to drop a new payload link.',
    evidence: [`gap before latest commit: ~${gapDays} days`, `latest: “${clip(latestMessage, 50)}”`],
    weight: WEIGHTS.staleCodeFreshReadme,
  };
};

// 9. Many historical contributors (inherited from a clone) but recent activity
//    is one human repeatedly touching the README.
export const clonedHistorySinglePusher: RepoRule = (repo) => {
  if ((repo.contributorsCount ?? 0) < THRESHOLDS.clonedHistoryMinContributors) return null;
  if (repo.recentCommits.length === 0) return null;

  const humanCommits = repo.recentCommits.filter((c) => !isBotAuthor(c.authorName));
  if (humanCommits.length === 0) return null;

  const authors = new Set(humanCommits.map((c) => (c.authorLogin ?? c.authorName).toLowerCase()));
  if (authors.size !== 1) return null;

  // The lone pusher must be doing README-ish work for this to indicate the
  // campaign rather than a normal solo-maintained fork.
  const touchesReadme = humanCommits.some((c) => {
    const msg = c.message.split('\n')[0]?.trim() ?? '';
    const filesReadme = c.changedFiles?.every((f) => README_FILE.test(f.split('/').pop() ?? '')) ?? false;
    return TRIVIAL_COMMIT_MESSAGES.some((re) => re.test(msg)) || filesReadme;
  });
  if (!touchesReadme) return null;

  return {
    id: 'cloned-history-single-pusher',
    title: 'Inherited multi-contributor history, single recent README editor',
    severity: 'medium',
    detail:
      `This repo shows ${repo.contributorsCount} contributors in its history, ` +
      `but recent activity is a single account ("${[...authors][0]}") only ` +
      'touching the README — consistent with a copied project whose original ' +
      'contributor list was inherited, not earned.',
    evidence: [`contributors: ${repo.contributorsCount}`, `recent author: ${[...authors][0]}`],
    weight: WEIGHTS.clonedHistorySinglePusher,
  };
};

// 10. A release ships an executable/loader with a campaign-typical name.
export const suspiciousReleaseAsset: RepoRule = (repo) => {
  if (repo.releaseAssets.length === 0) return null;
  const flagged = repo.releaseAssets.filter((a) => {
    const name = a.name.toLowerCase();
    return (
      SUSPICIOUS_PAYLOAD_NAMES.includes(name as (typeof SUSPICIOUS_PAYLOAD_NAMES)[number]) ||
      PAYLOAD_FILENAME_PATTERNS.some((re) => re.test(name)) ||
      hasExtension(name, EXECUTABLE_EXTENSIONS)
    );
  });
  if (flagged.length === 0) return null;

  const looksLikeLoader = flagged.some((a) =>
    PAYLOAD_FILENAME_PATTERNS.some((re) => re.test(a.name.toLowerCase())) ||
    SUSPICIOUS_PAYLOAD_NAMES.includes(a.name.toLowerCase() as (typeof SUSPICIOUS_PAYLOAD_NAMES)[number]),
  );

  return {
    id: 'suspicious-release-asset',
    title: 'Release ships a suspicious executable / loader',
    severity: looksLikeLoader ? 'critical' : 'high',
    detail:
      'Release assets include executables matching the campaign\'s rotating ' +
      'payload names (loader.exe, unit.exe, boot.exe, java.exe, lua51.dll) or a ' +
      'batch launcher. The LuaJIT loader is distributed exactly this way.',
    remediation: 'Do not download or run these assets. Report the repository to GitHub if it is impersonating a project.',
    evidence: flagged.slice(0, 5).map((a) => `asset: ${a.name}`),
    weight: WEIGHTS.suspiciousReleaseAsset,
  };
};

// 11. The repo tree itself contains a loader/launcher/payload data file.
export const suspiciousTreePayload: RepoRule = (repo) => {
  if (!repo.treePaths || repo.treePaths.length === 0) return null;
  const flagged = repo.treePaths.filter((p) => {
    const name = p.split('/').pop() ?? '';
    return (
      PAYLOAD_FILENAME_PATTERNS.some((re) => re.test(name)) ||
      SUSPICIOUS_PAYLOAD_NAMES.includes(name.toLowerCase() as (typeof SUSPICIOUS_PAYLOAD_NAMES)[number])
    );
  });
  if (flagged.length === 0) return null;

  return {
    id: 'suspicious-tree-payload',
    title: 'Repository contains a loader / launcher payload file',
    severity: 'critical',
    detail:
      'A LuaJIT loader, lua51.dll, a .cmd/.bat launcher, or a .cso data blob is ' +
      'committed in the repo tree — the exact file set bundled in the campaign\'s ZIPs.',
    remediation: 'Do not clone or run this repository. Report it to GitHub.',
    evidence: flagged.slice(0, 5).map((p) => `file: ${clip(p, 80)}`),
    weight: WEIGHTS.suspiciousTreePayload,
  };
};

// 12. An archive buried deep in the tree, disguised as a normal release artifact.
export const archiveBuriedDeep: RepoRule = (repo) => {
  if (!repo.treePaths || repo.treePaths.length === 0) return null;
  const flagged = repo.treePaths.filter((p) => {
    const depth = p.split('/').length;
    return depth >= 3 && hasExtension(p, ARCHIVE_EXTENSIONS);
  });
  if (flagged.length === 0) return null;

  return {
    id: 'archive-buried-deep',
    title: 'Archive buried deep in the repository tree',
    severity: 'medium',
    detail:
      'An archive sits several directories deep, dressed up as an ordinary ' +
      'release artifact (repo/some/deep/path/project-version.zip). The campaign ' +
      'hides the payload this way and links every README button to it.',
    evidence: flagged.slice(0, 4).map((p) => `archive: ${clip(p, 80)}`),
    weight: WEIGHTS.archiveBuriedDeep,
  };
};

// 13. Looks like an independent repo but duplicates a more-popular project's
//     name without being a fork (set by clone-detection context).
export const notForkButDuplicateName: RepoRule = (repo, ctx) => {
  if (!ctx.duplicateOfFullName) return null;
  if (repo.isFork) return null;
  if (repo.fullName.toLowerCase() === ctx.duplicateOfFullName.toLowerCase()) return null;

  return {
    id: 'not-fork-but-duplicate',
    title: 'Independent repo duplicating a more-popular project',
    severity: 'medium',
    detail:
      `This repository carries the same name as ${ctx.duplicateOfFullName} ` +
      `(${ctx.duplicateOfStars ?? '?'}★) but is not a GitHub fork. The campaign ` +
      'publishes copies as standalone repos so they read as original work.',
    evidence: [`mirrors: ${ctx.duplicateOfFullName}`, `is_fork: ${repo.isFork}`],
    weight: WEIGHTS.notForkButDuplicateName,
  };
};

export const REPO_RULES: RepoRule[] = [
  readmeReferencesArchive,
  readmeDownloadBadgeToArchive,
  readmePasswordProtectedArchive,
  readmeUrlShortener,
  readmeDownloadLure,
  latestCommitOnlyReadme,
  trivialReadmeCommitMessage,
  staleCodeFreshReadme,
  clonedHistorySinglePusher,
  suspiciousReleaseAsset,
  suspiciousTreePayload,
  archiveBuriedDeep,
  notForkButDuplicateName,
];
