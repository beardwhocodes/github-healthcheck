import { describe, expect, it } from 'vitest';

import {
  buildCloneMatch,
  cloneConfidence,
  evaluateAccount,
  evaluateRepo,
} from '../src/engine/evaluate.js';
import { bandForScore, scoreFromFindings } from '../src/engine/score.js';
import type { Finding } from '../src/engine/types.js';
import { NOW, account, commit, daysAgoIso, repo, weaponizedClone } from './fixtures.js';

// A repo that trips ALL FOUR README-tampering signals but has NO payload — the
// dominant false-positive class (the owner just updated their own README).
function benignReadmeOnlyRepo(readmeText = '# My Project\n\nA useful tool. MIT licensed.') {
  return repo({
    isFork: false,
    contributorsCount: 6,
    readmeText,
    recentCommits: [
      commit({ message: 'Update README.md', authorLogin: 'me', authorName: 'me', authorDate: daysAgoIso(1), changedFiles: ['README.md'] }),
      commit({ message: 'Update README.md', authorLogin: 'me', authorName: 'me', authorDate: daysAgoIso(400), sha: 'b'.repeat(40), changedFiles: ['README.md'] }),
    ],
  });
}

describe('scoreFromFindings', () => {
  it('is 0 with no findings', () => {
    expect(scoreFromFindings([])).toBe(0);
  });

  it('saturates toward but never exceeds 100', () => {
    const heavy: Finding[] = Array.from({ length: 10 }, (_, i) => ({
      id: `f${i}`,
      title: 't',
      severity: 'critical',
      detail: 'd',
      weight: 40,
    }));
    const score = scoreFromFindings(heavy);
    expect(score).toBeGreaterThan(90);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('orders bands correctly', () => {
    expect(bandForScore(0)).toBe('safe');
    expect(bandForScore(12)).toBe('low');
    expect(bandForScore(30)).toBe('elevated');
    expect(bandForScore(50)).toBe('high');
    expect(bandForScore(85)).toBe('critical');
  });

  it('floors a lone critical finding into the critical band', () => {
    const one: Finding[] = [
      { id: 'x', title: 't', severity: 'critical', detail: 'd', weight: 30 },
    ];
    expect(scoreFromFindings(one)).toBeGreaterThanOrEqual(70);
    expect(bandForScore(scoreFromFindings(one))).toBe('critical');
  });

  it('floors a lone high finding into at least the elevated band', () => {
    const one: Finding[] = [{ id: 'x', title: 't', severity: 'high', detail: 'd', weight: 10 }];
    expect(scoreFromFindings(one)).toBeGreaterThanOrEqual(35);
  });

  it('does not floor medium/low findings', () => {
    const one: Finding[] = [{ id: 'x', title: 't', severity: 'medium', detail: 'd', weight: 10 }];
    expect(scoreFromFindings(one)).toBeLessThan(20);
  });
});

describe('evaluateRepo', () => {
  it('rates a clean repo as safe with no findings', () => {
    const report = evaluateRepo(repo(), { now: NOW });
    expect(report.findings).toHaveLength(0);
    expect(report.band).toBe('safe');
    expect(report.score).toBe(0);
  });

  it('does NOT flag a benign README-only update as high (payload-gating)', () => {
    // The production false-positive: "Update README.md" on a dormant repo with
    // no download link. All four tampering signals fire but stay demoted.
    const report = evaluateRepo(benignReadmeOnlyRepo(), { now: NOW });
    expect(['safe', 'low']).toContain(report.band);
    expect(report.score).toBeLessThan(25); // below the 'elevated' cutoff
    // The findings are still VISIBLE (as informational low) for human review.
    const ids = report.findings.map((f) => f.id);
    expect(ids).toContain('latest-commit-only-readme');
    expect(report.findings.find((f) => f.id === 'latest-commit-only-readme')!.severity).toBe('low');
  });

  it('all four tampering signals without a payload stay below elevated', () => {
    const report = evaluateRepo(benignReadmeOnlyRepo(), { now: NOW });
    const tamperingIds = ['latest-commit-only-readme', 'trivial-readme-commit-message', 'stale-code-fresh-readme', 'cloned-history-single-pusher'];
    const fired = report.findings.filter((f) => tamperingIds.includes(f.id));
    expect(fired.length).toBe(4); // all four fire...
    expect(fired.every((f) => f.severity === 'low')).toBe(true); // ...but demoted
    expect(report.score).toBeLessThan(25);
  });

  it('ARMS the tampering signals when an external download link is present', () => {
    const report = evaluateRepo(
      benignReadmeOnlyRepo('# My Project\n\nDownload: https://evilhost.example/setup.zip'),
      { now: NOW },
    );
    expect(['high', 'critical']).toContain(report.band);
    expect(report.score).toBeGreaterThanOrEqual(45);
    // Now the tampering signals are restored to full strength.
    expect(report.findings.find((f) => f.id === 'latest-commit-only-readme')!.severity).toBe('high');
  });

  it('a GitHub release link does NOT arm the gate (legit distribution)', () => {
    const report = evaluateRepo(
      benignReadmeOnlyRepo('# My Project\n\nDownload: https://github.com/me/proj/releases/download/v1/proj.zip'),
      { now: NOW },
    );
    expect(['safe', 'low']).toContain(report.band);
    expect(report.score).toBeLessThan(25);
  });

  it('rates the canonical weaponized clone as critical', () => {
    const report = evaluateRepo(weaponizedClone(), { now: NOW });
    expect(report.band).toBe('critical');
    expect(report.score).toBeGreaterThanOrEqual(70);
    // The decisive campaign signals should all fire.
    const ids = report.findings.map((f) => f.id);
    expect(ids).toContain('latest-commit-only-readme');
    expect(ids).toContain('readme-password-archive');
    expect(ids).toContain('suspicious-release-asset');
    expect(ids).toContain('readme-url-shortener');
  });

  it('sorts findings by severity (critical first)', () => {
    const report = evaluateRepo(weaponizedClone(), { now: NOW });
    const severities = report.findings.map((f) => f.severity);
    const firstNonCritical = severities.findIndex((s) => s !== 'critical');
    if (firstNonCritical !== -1) {
      expect(severities.slice(firstNonCritical)).not.toContain('critical');
    }
  });
});

describe('evaluateAccount', () => {
  it('summarizes a healthy account as safe', () => {
    const repos = [repo(), repo({ name: 'second', fullName: 'realdev/second' })];
    const report = evaluateAccount({ account: account(), repos, now: NOW });
    expect(report.band).toBe('safe');
    expect(report.summary.reposScanned).toBe(2);
    expect(report.summary.flaggedRepos).toBe(0);
  });

  it('cannot read as safe when it hosts a malicious repo', () => {
    const repos = [repo(), weaponizedClone()];
    const report = evaluateAccount({ account: account(), repos, now: NOW });
    expect(report.summary.flaggedRepos).toBeGreaterThanOrEqual(1);
    expect(['high', 'critical']).toContain(report.band);
    // Worst repo sorts to the front.
    expect(report.repoReports[0]!.band).toBe('critical');
  });

  it('flags disabled 2FA for the signed-in user', () => {
    const report = evaluateAccount({
      account: account({ twoFactorEnabled: false }),
      repos: [repo()],
      now: NOW,
    });
    expect(report.findings.map((f) => f.id)).toContain('account-no-2fa');
  });

  it('flags an account that stages many clones in a burst', () => {
    const repos = Array.from({ length: 6 }, (_, i) =>
      repo({ name: `clone${i}`, fullName: `throwaway/clone${i}`, createdAt: daysAgoIso(3 + i * 0.1) }),
    );
    const report = evaluateAccount({
      account: account({ login: 'throwaway', createdAt: daysAgoIso(4), followers: 0, following: 0, publicRepos: 6 }),
      repos,
      now: NOW,
    });
    const ids = report.findings.map((f) => f.id);
    expect(ids).toContain('account-clustered-activity');
    expect(ids).toContain('account-very-new');
  });
});

describe('clone detection', () => {
  it('scores a malicious copy under a different owner as high-confidence', () => {
    const suspect = weaponizedClone();
    const report = evaluateRepo(suspect, { now: NOW });
    const { confidence, reasons } = cloneConfidence(report, {
      sameName: true,
      sameDescription: true,
      suspectIsFork: false,
      suspectStars: 0,
      sourceStars: 5000,
      differentOwner: true,
    });
    expect(confidence).toBeGreaterThanOrEqual(70);
    expect(reasons.length).toBeGreaterThan(0);
  });

  it('builds a CloneMatch with source/suspect metadata', () => {
    const suspect = weaponizedClone();
    const report = evaluateRepo(suspect, { now: NOW });
    const match = buildCloneMatch({
      sourceRepo: 'realdev/awesome-lib',
      suspect,
      report,
      signals: {
        sameName: true,
        sameDescription: false,
        suspectIsFork: false,
        suspectStars: 0,
        sourceStars: 5000,
        differentOwner: true,
      },
    });
    expect(match.sourceRepo).toBe('realdev/awesome-lib');
    expect(match.suspectRepo).toBe('throwaway123/awesome-lib');
    expect(match.suspectOwner).toBe('throwaway123');
    expect(match.confidence).toBeGreaterThan(0);
  });

  it('gives a benign different-owner same-name repo low confidence', () => {
    const benign = repo({ owner: 'someoneelse', fullName: 'someoneelse/awesome-lib' });
    const report = evaluateRepo(benign, { now: NOW });
    const { confidence } = cloneConfidence(report, {
      sameName: true,
      sameDescription: false,
      suspectIsFork: false,
      suspectStars: 10,
      sourceStars: 12,
      differentOwner: true,
    });
    // Structural-only collision (no malware, no copied description) must be
    // capped below the alert threshold (35) so common name clashes don't alert.
    expect(confidence).toBeLessThanOrEqual(20);
  });

  it('still flags a different-owner copy that shares the description', () => {
    const benign = repo({ owner: 'someoneelse', fullName: 'someoneelse/awesome-lib' });
    const report = evaluateRepo(benign, { now: NOW });
    const { confidence } = cloneConfidence(report, {
      sameName: true,
      sameDescription: true,
      suspectIsFork: false,
      suspectStars: 10,
      sourceStars: 12,
      differentOwner: true,
    });
    // A copied description is a genuine signal, so the cap does not apply.
    expect(confidence).toBeGreaterThanOrEqual(45);
  });
});
