import { describe, expect, it } from 'vitest';

import { buildCloneMatch, evaluateRepo } from '../src/engine/evaluate.js';
import type { CloneMatch } from '../src/engine/types.js';
import {
  buildEvidenceText,
  buildReportUrl,
  pickAbuseCategory,
} from '../web/src/report.js';
import { NOW, repo, weaponizedClone } from './fixtures.js';

function maliciousMatch(): CloneMatch {
  const suspect = weaponizedClone();
  const report = evaluateRepo(suspect, { now: NOW });
  return buildCloneMatch({
    sourceRepo: 'realdev/awesome-lib',
    suspect,
    report,
    signals: { sameName: true, sameDescription: false, suspectIsFork: false, suspectStars: 0, sourceStars: 5000, differentOwner: true },
  });
}

function impersonationOnlyMatch(): CloneMatch {
  const suspect = repo({ owner: 'someoneelse', fullName: 'someoneelse/awesome-lib' });
  const report = evaluateRepo(suspect, { now: NOW }); // clean -> safe, no findings
  return buildCloneMatch({
    sourceRepo: 'realdev/awesome-lib',
    suspect,
    report,
    signals: { sameName: true, sameDescription: true, suspectIsFork: false, suspectStars: 1, sourceStars: 5000, differentOwner: true },
  });
}

describe('buildReportUrl', () => {
  it('targets support.github.com (not the param-stripping github.com redirect)', () => {
    const url = new URL(buildReportUrl(maliciousMatch()));
    expect(url.host).toBe('support.github.com');
    expect(url.pathname).toBe('/contact/report-abuse');
  });

  it('attaches the suspect repo, content url, category, and malware report_type', () => {
    const m = maliciousMatch();
    const url = new URL(buildReportUrl(m, 'malware'));
    expect(url.searchParams.get('report')).toBe(m.suspectRepo);
    expect(url.searchParams.get('report_content_url')).toBe(m.suspectUrl);
    expect(url.searchParams.get('report_type')).toBe('cat_ts_malware');
    expect(url.searchParams.get('category')).toBe('report-abuse');
  });

  it('uses the impersonation taxonomy id when asked', () => {
    const url = new URL(buildReportUrl(maliciousMatch(), 'impersonation'));
    expect(url.searchParams.get('report_type')).toBe('cat_ts_impersonation');
  });
});

describe('pickAbuseCategory', () => {
  it('is malware for a high/critical clone', () => {
    expect(pickAbuseCategory(maliciousMatch())).toBe('malware');
  });

  it('is impersonation when there are no strong findings', () => {
    expect(pickAbuseCategory(impersonationOnlyMatch())).toBe('impersonation');
  });
});

describe('buildEvidenceText', () => {
  it('includes source, suspect, confidence and stays hedged', () => {
    const m = maliciousMatch();
    const text = buildEvidenceText(m);
    expect(text).toContain(m.sourceRepo);
    expect(text).toContain(m.suspectUrl);
    expect(text).toContain(`${m.confidence}/100`);
    expect(text).toContain('appears to be a malicious clone');
    expect(text).toContain('Reported via GitHub Healthcheck');
  });
});
