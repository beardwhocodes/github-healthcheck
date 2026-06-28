import { THRESHOLDS, WEIGHTS } from '../constants.js';
import { daysBetween } from '../helpers.js';
import type { AccountSnapshot, Finding, RepoReport, RepoSnapshot } from '../types.js';

export interface AccountRuleContext {
  now: number;
}

export type AccountRule = (
  account: AccountSnapshot,
  repos: RepoSnapshot[],
  reports: RepoReport[],
  ctx: AccountRuleContext,
) => Finding | null;

// 1. Brand-new account. Benign by itself, but every other signal weighs more
//    heavily on an account with no history.
export const accountVeryNew: AccountRule = (account, _repos, _reports, ctx) => {
  const ageDays = daysBetween(account.createdAt, ctx.now);
  if (ageDays >= THRESHOLDS.newAccountDays) return null;

  return {
    id: 'account-very-new',
    title: 'Account was created very recently',
    severity: 'info',
    detail:
      `This account is only ~${Math.max(0, Math.round(ageDays))} days old. The ` +
      'campaign spins up throwaway accounts, so newness amplifies any other ' +
      'red flags found below.',
    evidence: [`created: ${account.createdAt.slice(0, 10)}`],
    weight: WEIGHTS.accountVeryNew,
  };
};

// 2. Two-factor disabled (only known for the signed-in user themselves).
export const accountNoTwoFactor: AccountRule = (account) => {
  if (account.twoFactorEnabled !== false) return null;

  return {
    id: 'account-no-2fa',
    title: 'Two-factor authentication is disabled',
    severity: 'high',
    detail:
      'Account takeover is how attackers turn a trusted account into a malware ' +
      'distributor without ever cloning anything. 2FA is the single best defense.',
    remediation: 'Enable 2FA now: github.com/settings/security. Prefer a security key or TOTP app over SMS.',
    weight: WEIGHTS.accountNoTwoFactor,
  };
};

// 3. Repos created in a tight burst rather than organically over time.
export const accountClusteredActivity: AccountRule = (account, repos) => {
  const created = repos
    .map((r) => new Date(r.createdAt).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  if (created.length < THRESHOLDS.clusteredActivityMinRepos) return null;

  // Largest count of repos created within any 7-day window.
  const windowMs = 7 * 24 * 60 * 60 * 1000;
  let maxInWindow = 0;
  let start = 0;
  for (let end = 0; end < created.length; end++) {
    const endTime = created[end];
    if (endTime === undefined) continue;
    // `start` only ever trails `end`, so created[start] stays defined; re-reading
    // it (and the undefined check) keeps the index access honest without altering
    // the window math.
    let startTime = created[start];
    while (startTime !== undefined && endTime - startTime > windowMs) {
      start++;
      startTime = created[start];
    }
    maxInWindow = Math.max(maxInWindow, end - start + 1);
  }

  if (maxInWindow < THRESHOLDS.clusteredActivityMinRepos) return null;

  return {
    id: 'account-clustered-activity',
    title: 'Many repositories created in a short burst',
    severity: 'medium',
    detail:
      `${maxInWindow} repositories were created within a single 7-day window. ` +
      'Clustered, bot-like repo creation (rather than activity spread over time) ' +
      'matches how the campaign stages many clones at once.',
    evidence: [`peak: ${maxInWindow} repos / 7 days`, `public repos: ${account.publicRepos}`],
    weight: WEIGHTS.accountClusteredActivity,
  };
};

// 4. Several of the account's repos have archive-pushing READMEs — i.e. the
//    account itself looks like a distribution hub, not a one-off.
export const accountManyArchiveReadmes: AccountRule = (_account, _repos, reports) => {
  // A severity-'low' readme-references-archive is the deliberately-demoted
  // variant (a bare prose filename or a GitHub-hosted release link). Devs who
  // link their own GitHub releases should not be counted toward a "coordinated
  // distribution account" verdict, so only the arming (>= medium) variant
  // qualifies here.
  const archiveReadmeRepos = reports.filter((r) =>
    r.findings.some(
      (f) =>
        (f.id === 'readme-references-archive' && f.severity !== 'low') ||
        f.id === 'readme-download-badge',
    ),
  );
  if (archiveReadmeRepos.length < 2) return null;

  return {
    id: 'account-many-archive-readmes',
    title: 'Multiple repositories push binary downloads via their README',
    severity: archiveReadmeRepos.length >= 3 ? 'high' : 'medium',
    detail:
      `${archiveReadmeRepos.length} of this account's repositories steer readers ` +
      'to a binary/archive download from the README. A pattern across many repos ' +
      'is the signature of a coordinated distribution account.',
    evidence: archiveReadmeRepos.slice(0, 5).map((r) => r.repo.fullName),
    weight: WEIGHTS.accountManyArchiveReadmes,
  };
};

// 5. Lots of public repos but almost no social footprint (throwaway profile).
export const accountLowFollowersManyRepos: AccountRule = (account) => {
  if (account.publicRepos < 8) return null;
  if (account.followers > 2 || account.following > 5) return null;

  return {
    id: 'account-low-social-footprint',
    title: 'Many repositories, near-zero social footprint',
    severity: 'low',
    detail:
      `${account.publicRepos} public repos but ${account.followers} followers ` +
      'and minimal following. Disposable distribution accounts publish in bulk ' +
      'while building no genuine community presence.',
    evidence: [`repos: ${account.publicRepos}`, `followers: ${account.followers}`],
    weight: WEIGHTS.accountLowFollowersManyRepos,
  };
};

export const ACCOUNT_RULES: AccountRule[] = [
  accountVeryNew,
  accountNoTwoFactor,
  accountClusteredActivity,
  accountManyArchiveReadmes,
  accountLowFollowersManyRepos,
];
