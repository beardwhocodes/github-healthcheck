import {
  PAYLOAD_FINDING_IDS,
  TAMPERING_FINDING_IDS,
  TAMPER_UNARMED_FACTOR,
} from './constants.js';
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

// A genuine payload signal is a PAYLOAD-class finding of severity medium-or-
// higher. (The 'low' variant of readme-references-archive — a bare prose
// filename mention or a GitHub-hosted link — deliberately does NOT arm.)
function hasPayloadSignal(findings: Finding[]): boolean {
  return findings.some(
    (f) => PAYLOAD_FINDING_IDS.has(f.id) && SEVERITY_RANK[f.severity] <= SEVERITY_RANK.medium,
  );
}

// README-tampering without a corroborating payload is ordinary maintenance:
// demote it to an informational 'low' finding and strip its score weight so it
// cannot, by itself, push a benign repo above 'low'.
function demoteTampering(f: Finding): Finding {
  return {
    ...f,
    severity: 'low',
    weight: Math.round(f.weight * TAMPER_UNARMED_FACTOR),
    detail:
      `${f.detail} (No download/payload link was found in this repository, so on ` +
      'its own this is most likely ordinary maintenance — the campaign\'s tell is ' +
      'this pattern combined with a payload link.)',
  };
}

export function evaluateRepo(repo: RepoSnapshot, ctx: RepoRuleContext): RepoReport {
  const raw = REPO_RULES.map((rule) => rule(repo, ctx)).filter((f): f is Finding => f !== null);

  // Payload-gating: tampering findings are only "armed" when a real payload
  // signal is present; otherwise they are demoted so a benign README update
  // (the dominant false-positive class) scores low.
  const armed = hasPayloadSignal(raw);
  const gated = armed
    ? raw
    : raw.map((f) => (TAMPERING_FINDING_IDS.has(f.id) ? demoteTampering(f) : f));

  const findings = sortFindings(gated);
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

  // The suspect's own MALWARE report is the dominant factor — but exclude two
  // classes of finding that would otherwise let a benign same-name repo
  // bootstrap its own "malware" score:
  //  - 'not-fork-but-duplicate', itself a same-name structural signal (counting
  //    it would double-count the structural confidence already added above);
  //  - any severity-'low' finding, which on a per-repo report means a demoted/
  //    unarmed tampering signal or a non-arming README mention (e.g. a
  //    GitHub-release link). These must not register as malware here, or the
  //    structural-only cap below never engages for benign README collisions.
  const malwareScore = scoreFromFindings(
    report.findings.filter((f) => f.id !== 'not-fork-but-duplicate' && f.severity !== 'low'),
  );
  confidence += Math.round(malwareScore * 0.5);
  if (malwareScore > 0) {
    reasons.push(`malware indicators on the copy (risk ${malwareScore}/100)`);
  }

  // A copy with far fewer stars than the original is the expected direction.
  if (signals.suspectStars < signals.sourceStars && signals.sourceStars > 0) {
    confidence += 5;
  }

  // Structural-only matches (a shared name with no genuine content/malware
  // signal) must not clear the alert threshold — repo name collisions are
  // extremely common on GitHub. Require either a malware signal or a copied
  // description to be considered a real impersonation.
  if (malwareScore === 0 && !signals.sameDescription) {
    confidence = Math.min(confidence, 20);
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
