import { ACCOUNT_RULES } from './rules/account-rules.js';
import type { AccountRuleContext } from './rules/account-rules.js';
import { REPO_RULES } from './rules/repo-rules.js';
import type { RepoRuleContext } from './rules/repo-rules.js';
import { bandForScore, isFlagged, maxBand, scoreFromFindings } from './score.js';
import type {
  AccountReport,
  AccountSnapshot,
  CloneMatch,
  Finding,
  RepoReport,
  RepoSnapshot,
} from './types.js';

const SEVERITY_RANK: Record<Finding['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    return bySeverity !== 0 ? bySeverity : b.weight - a.weight;
  });
}

export function evaluateRepo(repo: RepoSnapshot, ctx: RepoRuleContext): RepoReport {
  const findings = sortFindings(
    REPO_RULES.map((rule) => rule(repo, ctx)).filter((f): f is Finding => f !== null),
  );
  const score = scoreFromFindings(findings);

  return {
    repo: {
      fullName: repo.fullName,
      htmlUrl: repo.htmlUrl,
      stargazers: repo.stargazers,
      isFork: repo.isFork,
      createdAt: repo.createdAt,
      pushedAt: repo.pushedAt,
    },
    findings,
    score,
    band: bandForScore(score),
  };
}

export interface EvaluateAccountInput {
  account: AccountSnapshot;
  repos: RepoSnapshot[];
  now: number;
}

export function evaluateAccount(input: EvaluateAccountInput): AccountReport {
  const { account, repos, now } = input;
  const repoCtx: RepoRuleContext = { now };
  const repoReports = repos.map((repo) => evaluateRepo(repo, repoCtx));

  const accountCtx: AccountRuleContext = { now };
  const accountFindings = sortFindings(
    ACCOUNT_RULES.map((rule) => rule(account, repos, repoReports, accountCtx)).filter(
      (f): f is Finding => f !== null,
    ),
  );

  // The account score blends its own findings with the worst repo signal, so an
  // account hosting one clearly-malicious repo can't read as "safe" overall.
  const worstRepoScore = repoReports.reduce((max, r) => Math.max(max, r.score), 0);
  const accountOwnScore = scoreFromFindings(accountFindings);
  const score = Math.max(accountOwnScore, Math.round(worstRepoScore * 0.85));

  const flaggedRepos = repoReports.filter((r) => isFlagged(r.band));

  return {
    account: {
      login: account.login,
      htmlUrl: account.htmlUrl,
      avatarUrl: account.avatarUrl,
      createdAt: account.createdAt,
      followers: account.followers,
      publicRepos: account.publicRepos,
      twoFactorEnabled: account.twoFactorEnabled,
    },
    findings: accountFindings,
    score,
    band: bandForScore(score),
    repoReports: [...repoReports].sort((a, b) => b.score - a.score),
    summary: {
      reposScanned: repoReports.length,
      flaggedRepos: flaggedRepos.length,
      topBand: maxBand(repoReports.map((r) => r.band)),
    },
  };
}

// Score how confident we are that `suspect` is a malicious clone of `source`.
// Combines the suspect's own risk report with structural clone signals.
export interface CloneSignals {
  sameName: boolean;
  sameDescription: boolean;
  suspectIsFork: boolean;
  suspectStars: number;
  sourceStars: number;
  differentOwner: boolean;
}

export function cloneConfidence(report: RepoReport, signals: CloneSignals): {
  confidence: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let confidence = 0;

  if (signals.differentOwner && signals.sameName) {
    confidence += 25;
    reasons.push('same repo name under a different owner');
  }
  if (signals.sameDescription) {
    confidence += 20;
    reasons.push('identical repository description');
  }
  if (!signals.suspectIsFork && signals.sameName && signals.differentOwner) {
    confidence += 15;
    reasons.push('published as a standalone repo, not a GitHub fork');
  }
  // The suspect's own malware report is the dominant factor.
  confidence += Math.round(report.score * 0.5);
  if (report.score > 0) {
    reasons.push(`malware indicators on the copy (risk ${report.score}/100)`);
  }
  // A copy with far fewer stars than the original is the expected direction.
  if (signals.suspectStars < signals.sourceStars && signals.sourceStars > 0) {
    confidence += 5;
  }

  return { confidence: Math.min(100, confidence), reasons };
}

export function buildCloneMatch(args: {
  sourceRepo: string;
  suspect: RepoSnapshot;
  report: RepoReport;
  signals: CloneSignals;
}): CloneMatch {
  const { confidence, reasons } = cloneConfidence(args.report, args.signals);
  return {
    sourceRepo: args.sourceRepo,
    suspectRepo: args.suspect.fullName,
    suspectUrl: args.suspect.htmlUrl,
    suspectOwner: args.suspect.owner,
    suspectStars: args.suspect.stargazers,
    suspectCreatedAt: args.suspect.createdAt,
    report: args.report,
    confidence,
    matchReasons: reasons,
  };
}
