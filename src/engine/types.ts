// Domain types for the detection engine.
//
// The engine is intentionally pure: it receives plain data snapshots (gathered
// elsewhere by the GitHub client) and returns structured findings + scores. No
// network, no Workers APIs. This makes every rule unit-testable in isolation.

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type RiskBand = 'safe' | 'low' | 'elevated' | 'high' | 'critical';

// A single commit, trimmed to what the rules need.
export interface CommitInfo {
  sha: string;
  message: string;
  authorName: string;
  authorLogin: string | null;
  authorDate: string; // ISO-8601
  // Filenames changed by this commit, when known (latest commit only).
  changedFiles?: string[];
}

// A release asset (downloadable binary attached to a GitHub release).
export interface ReleaseAsset {
  name: string;
  downloadUrl: string;
  sizeBytes: number;
}

// Everything the repo-level rules need about one repository.
export interface RepoSnapshot {
  owner: string;
  name: string;
  fullName: string; // owner/name
  htmlUrl: string;
  description: string | null;
  topics: string[];
  isFork: boolean;
  isArchived: boolean;
  createdAt: string; // ISO-8601
  pushedAt: string | null; // ISO-8601
  updatedAt: string | null; // ISO-8601
  defaultBranch: string;
  stargazers: number;
  forks: number;
  watchers: number;
  openIssues: number;
  sizeKb: number;
  // README rendered as raw markdown/text (null when absent).
  readmeText: string | null;
  // Most-recent commits on the default branch, newest first (typically <= 5).
  recentCommits: CommitInfo[];
  // Distinct contributor count from the full history (clones inherit many).
  contributorsCount: number | null;
  // Release assets across recent releases.
  releaseAssets: ReleaseAsset[];
  // Paths of files in the repo tree (when fetched; used to spot buried archives).
  treePaths?: string[];
}

// Everything the account-level rules need.
export interface AccountSnapshot {
  login: string;
  type: 'User' | 'Organization';
  name: string | null;
  bio: string | null;
  company: string | null;
  blog: string | null;
  email: string | null;
  avatarUrl: string;
  htmlUrl: string;
  createdAt: string; // ISO-8601
  updatedAt: string | null;
  followers: number;
  following: number;
  publicRepos: number;
  // Only known when evaluating the *authenticated* user's own account.
  twoFactorEnabled: boolean | null;
}

// One detected signal. Rules return these.
export interface Finding {
  id: string; // stable rule id, e.g. 'readme-references-archive'
  title: string;
  severity: Severity;
  // Plain-language explanation tying the signal to the campaign.
  detail: string;
  // What the user should do about it.
  remediation?: string;
  // Concrete evidence (matched strings, filenames, urls) for transparency.
  evidence?: string[];
  // Points this finding contributes to the risk score (0-100 scale).
  weight: number;
}

export interface RepoReport {
  repo: Pick<
    RepoSnapshot,
    'fullName' | 'htmlUrl' | 'stargazers' | 'isFork' | 'createdAt' | 'pushedAt'
  >;
  findings: Finding[];
  score: number; // 0 (safe) .. 100 (almost certainly malicious)
  band: RiskBand;
}

export interface AccountReport {
  account: Pick<
    AccountSnapshot,
    'login' | 'htmlUrl' | 'avatarUrl' | 'createdAt' | 'followers' | 'publicRepos' | 'twoFactorEnabled'
  >;
  findings: Finding[]; // account-level findings
  score: number;
  band: RiskBand;
  repoReports: RepoReport[];
  // Rollup counts for the dashboard.
  summary: {
    reposScanned: number;
    flaggedRepos: number; // repos in 'high' or 'critical' band
    topBand: RiskBand;
  };
}

// A candidate clone of one of the user's repos, found elsewhere on GitHub.
export interface CloneMatch {
  // The user's repo that appears to have been cloned.
  sourceRepo: string; // owner/name
  // The suspected impersonating repo.
  suspectRepo: string; // owner/name
  suspectUrl: string;
  suspectOwner: string;
  suspectStars: number;
  suspectCreatedAt: string;
  // Why we think this is a malicious clone (reuses the repo-level findings).
  report: RepoReport;
  // How confident we are this is an impersonation, 0..100.
  confidence: number;
  matchReasons: string[];
}
