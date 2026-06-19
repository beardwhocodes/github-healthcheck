// Indicators of compromise, distilled from:
//  - orchidfiles.com/github-repositories-distributing-malware (the campaign)
//  - github.com/orchidfiles/git-malware-finder (the author's detection CLI)
//  - hexastrike.com SmartLoader/StealC analysis (109-repo cluster)
//
// Kept as data (not buried in rule logic) so the vocabulary is reviewable and
// easy to extend as the campaign evolves.

// Binary / archive file extensions. The CLI flags a README that merely mentions
// any of these; a clone's only payload is a link to one of these archives.
export const ARCHIVE_EXTENSIONS = [
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.tar.gz',
  '.tgz',
  '.gz',
  '.bz2',
  '.xz',
  '.iso',
  '.dmg',
  '.msi',
] as const;

export const EXECUTABLE_EXTENSIONS = [
  '.exe',
  '.dll',
  '.so',
  '.bin',
  '.jar',
  '.apk',
  '.scr',
  '.bat',
  '.cmd',
  '.cso',
] as const;
// Note: '.com' is intentionally excluded — as an executable extension it is
// archaic, and it collides with every "github.com"/"example.com" URL.

export const BINARY_EXTENSIONS = [
  ...ARCHIVE_EXTENSIONS,
  ...EXECUTABLE_EXTENSIONS,
] as const;

// Extensions safe to scan for as bare filename tokens in README *prose* (e.g.
// "Setup.exe"). Excludes ambiguous extensions that collide with hostnames,
// paths, or English ('.so', '.bin', '.com', '.gz', '.xz', '.bz2') to avoid the
// pervasive false positives a naive substring match produces.
export const PROSE_BINARY_EXTENSIONS = [
  'zip',
  'rar',
  '7z',
  'tar',
  'tgz',
  'iso',
  'dmg',
  'msi',
  'exe',
  'dll',
  'scr',
  'jar',
  'apk',
  'cso',
  'bat',
  'cmd',
] as const;

// Executable / launcher filenames seen in the campaign's ZIP payloads. Names
// rotate but stay generic. Matched against release assets and tree paths.
export const SUSPICIOUS_PAYLOAD_NAMES = [
  'loader.exe',
  'launcher.exe',
  'unit.exe',
  'boot.exe',
  'java.exe',
  'luajit.exe',
  'lua51.dll',
  'lua5.1.dll',
  'application.cmd',
  'launcher.cmd',
  'install.cmd',
  'setup.cmd',
  'run.bat',
  'start.bat',
] as const;

// The LuaJIT loader and its data files.
export const PAYLOAD_FILENAME_PATTERNS: RegExp[] = [
  /\blua(jit)?\d*\.(exe|dll)\b/i,
  /\bloader\.(exe|bin)\b/i,
  /\b(application|launcher|install|setup|run|start)\.(cmd|bat)\b/i,
  /\.cso\b/i, // obfuscated lua data file extension seen in payloads
];

// URL shorteners / paste hosts commonly used to hide the final download.
export const URL_SHORTENERS = [
  'bit.ly',
  'tinyurl.com',
  'cutt.ly',
  'rebrand.ly',
  't.ly',
  'is.gd',
  'shorturl.at',
  'rb.gy',
  's.id',
  'ow.ly',
  'tiny.cc',
  'telegra.ph',
  'telegram.me',
  't.me',
  'mediafire.com',
  'mega.nz',
  'anonfiles.com',
  'gofile.io',
  'pixeldrain.com',
  'bit.do',
  'short.gy',
] as const;

// Phrases indicating a password-protected archive — a hallmark used to defeat
// antivirus and VirusTotal URL scanning.
export const PASSWORD_ARCHIVE_PATTERNS: RegExp[] = [
  /\bpassword\s*[:=]/i,
  /\bpass\s*[:=]/i,
  /\bpassword\s+is\b/i,
  /\barchive\s+password\b/i,
  /\bwinrar\s+password\b/i,
  /\bpwd\s*[:=]/i,
  /\bunzip\s+password\b/i,
];

// Lure phrasing pushing a download of cracked / free / pirated software — the
// social-engineering hook in many weaponized READMEs.
export const DOWNLOAD_LURE_PATTERNS: RegExp[] = [
  /\bfree\s+download\b/i,
  /\bdownload\s+(now|here|free|setup|installer|crack)\b/i,
  /\bcracked?\b/i,
  /\bkeygen\b/i,
  /\bactivator\b/i,
  /\blicense\s+key\b/i,
  /\bfull\s+version\b/i,
  /\bnulled\b/i,
  /\bpre[-\s]?activated\b/i,
];

// Trivial commit messages that, on an otherwise stale codebase, signal a clone
// whose only change is a weaponized README. ("Update README.md" is THE tell.)
export const TRIVIAL_COMMIT_MESSAGES: RegExp[] = [
  /^update\s+readme(\.md)?\.?$/i,
  /^update\s+readme\s+file\.?$/i,
  /^readme\.?$/i,
  /^update\.?$/i,
  /^updated?\s+files?\.?$/i,
  /^create\s+readme(\.md)?\.?$/i,
];

// Bot author identities to exclude from "single human pusher" heuristics.
export const BOT_AUTHOR_PATTERNS: RegExp[] = [
  /\[bot\]/i,
  /github-actions/i,
  /dependabot/i,
  /renovate/i,
  /semantic-release/i,
];

// shields.io / badge image hosts. A README dominated by download *badges* that
// link to an archive is a strong campaign signal.
export const BADGE_HOSTS = ['img.shields.io', 'shields.io', 'badgen.net'] as const;

// Thresholds (mirrors git-malware-finder/src/config.ts where applicable).
export const THRESHOLDS = {
  // A repo younger than this with download lures is extra suspicious (days).
  newAccountDays: 30,
  newRepoDays: 14,
  // Gap (hours) between the two most recent commits that, combined with a
  // README-only latest commit, indicates "stale code, freshly weaponized".
  staleCodeGapHours: 30 * 24, // 30 days
  // Author's automation cadence: README rewrite every few hours.
  automationGapHoursMax: 30,
  // A repo with at least this many contributors but recent single-author
  // README edits looks like an inherited (cloned) history.
  clonedHistoryMinContributors: 3,
  // Account whose repos are mostly created in a burst.
  clusteredActivityMinRepos: 5,
} as const;

// Score weights per finding (0..100 risk scale). Tuned so that the canonical
// campaign combo (archive link + README-only latest commit + trivial message)
// lands a repo firmly in the 'high'/'critical' band on its own.
export const WEIGHTS = {
  readmeReferencesArchive: 18,
  readmeDownloadBadgeToArchive: 22,
  readmePasswordProtectedArchive: 28,
  readmeUrlShortener: 16,
  readmeDownloadLure: 14,
  latestCommitOnlyReadme: 26,
  trivialReadmeCommitMessage: 16,
  staleCodeFreshReadme: 20,
  clonedHistorySinglePusher: 18,
  suspiciousReleaseAsset: 34,
  suspiciousReleaseAssetBareExe: 12,
  suspiciousTreePayload: 30,
  archiveBuriedDeep: 18,
  notForkButDuplicateName: 12,
  // account-level
  accountVeryNew: 14,
  accountNoTwoFactor: 10,
  accountClusteredActivity: 12,
  accountManyArchiveReadmes: 22,
  accountLowFollowersManyRepos: 8,
} as const;

// Band thresholds on the 0..100 score.
export const BAND_THRESHOLDS: { band: import('./types.js').RiskBand; min: number }[] = [
  { band: 'critical', min: 70 },
  { band: 'high', min: 45 },
  { band: 'elevated', min: 25 },
  { band: 'low', min: 10 },
  { band: 'safe', min: 0 },
];

// Payload-gating (the core of the false-positive fix).
//
// The campaign's defining trait is README TAMPERING *corroborated by a PAYLOAD*
// signal. README tampering on its own — "Update README.md", a README-only
// commit, a dormant repo whose README was just bumped — is ordinary maintenance
// and must NOT score high. So tampering findings are "armed" only when at least
// one genuine payload finding (severity medium-or-higher) is also present; when
// unarmed they are demoted to informational and down-weighted.
export const PAYLOAD_FINDING_IDS: ReadonlySet<string> = new Set([
  'readme-references-archive',
  'readme-download-badge',
  'readme-password-archive',
  'readme-url-shortener',
  'readme-download-lure',
  'suspicious-release-asset',
  'suspicious-tree-payload',
  'archive-buried-deep',
]);

export const TAMPERING_FINDING_IDS: ReadonlySet<string> = new Set([
  'latest-commit-only-readme',
  'trivial-readme-commit-message',
  'stale-code-fresh-readme',
  'cloned-history-single-pusher',
]);

// Factor applied to a tampering finding's weight when it is UNARMED (no payload).
// 0.25 keeps all four tampering signals together comfortably under the
// 'elevated' cutoff (25) — with headroom so a weak non-arming payload mention
// (e.g. a GitHub-release link) can't tip a benign "I updated my README" repo
// over. Armed tampering is unaffected (full strength), so real-clone detection
// is preserved.
export const TAMPER_UNARMED_FACTOR = 0.25;

// Archive paths under these directories are test fixtures / examples, not a
// disguised payload — archive-buried-deep ignores them.
export const TEST_FIXTURE_DIR_RE =
  /(^|\/)(tests?|fixtures?|__fixtures__|testdata|spec|examples?|samples?|mocks?|__mocks__)\//i;
