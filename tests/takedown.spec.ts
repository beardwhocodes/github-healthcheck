import { describe, expect, it } from 'vitest';

import { buildTakedownDraft } from '../src/reports/takedown.js';
import type { ReportRecord } from '../src/reports/store.js';

// Minimal confirmed record with all optional fields populated.
function fullRecord(): ReportRecord {
  return {
    id: 'rec_abc123',
    reporterLogin: 'alice',
    suspectRepo: 'evil-actor/awesome-lib',
    suspectUrl: 'https://github.com/evil-actor/awesome-lib',
    sourceRepo: 'realdev/awesome-lib',
    confidence: 87,
    category: 'malware',
    status: 'confirmed',
    adminNotes: 'Contains loader.exe in releases.',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_001_000_000,
  };
}

// Record with all nullable fields absent.
function sparseRecord(): ReportRecord {
  return {
    id: 'rec_xyz789',
    reporterLogin: 'bob',
    suspectRepo: 'mystery/awesome-lib',
    suspectUrl: null,
    sourceRepo: null,
    confidence: null,
    category: null,
    status: 'confirmed',
    adminNotes: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_001_000_000,
  };
}

describe('buildTakedownDraft — full record', () => {
  it('subject includes the suspect repo and category label', () => {
    const { subject } = buildTakedownDraft(fullRecord());
    expect(subject).toContain('evil-actor/awesome-lib');
    expect(subject).toContain('malware/exploits');
  });

  it('body includes suspect repo, suspect URL, and source repo', () => {
    const { body } = buildTakedownDraft(fullRecord());
    expect(body).toContain('evil-actor/awesome-lib');
    expect(body).toContain('https://github.com/evil-actor/awesome-lib');
    expect(body).toContain('realdev/awesome-lib');
  });

  it('body includes confidence score', () => {
    const { body } = buildTakedownDraft(fullRecord());
    expect(body).toContain('87/100');
  });

  it('body includes reporter login', () => {
    const { body } = buildTakedownDraft(fullRecord());
    expect(body).toContain('@alice');
  });

  it('body includes admin notes', () => {
    const { body } = buildTakedownDraft(fullRecord());
    expect(body).toContain('Contains loader.exe in releases.');
  });

  it('body includes a prefilled GitHub report URL pointing to support.github.com', () => {
    const { body } = buildTakedownDraft(fullRecord());
    const match = body.match(/https:\/\/support\.github\.com\/contact\/report-abuse\?[^\s]+/);
    expect(match).not.toBeNull();
    const url = new URL(match![0]);
    expect(url.searchParams.get('report')).toBe('evil-actor/awesome-lib');
    expect(url.searchParams.get('report_type')).toBe('cat_ts_malware');
    expect(url.searchParams.get('report_content_url')).toBe(
      'https://github.com/evil-actor/awesome-lib',
    );
  });
});

describe('buildTakedownDraft — sparse record (all nullable fields absent)', () => {
  it('falls back to impersonation category when category is null', () => {
    const { subject, body } = buildTakedownDraft(sparseRecord());
    expect(subject).toContain('impersonation');
    expect(body).toContain('cat_ts_impersonation');
  });

  it('constructs suspect URL from suspectRepo when suspectUrl is null', () => {
    const { body } = buildTakedownDraft(sparseRecord());
    expect(body).toContain('https://github.com/mystery/awesome-lib');
  });

  it('includes a null-URL notice when suspectUrl is absent', () => {
    const { body } = buildTakedownDraft(sparseRecord());
    expect(body).toContain('suspect URL was not recorded');
  });

  it('omits confidence line when confidence is null', () => {
    const { body } = buildTakedownDraft(sparseRecord());
    expect(body).not.toContain('/100');
  });

  it('still includes the reporter login', () => {
    const { body } = buildTakedownDraft(sparseRecord());
    expect(body).toContain('@bob');
  });

  it('body does not throw on an all-null optional record', () => {
    expect(() => buildTakedownDraft(sparseRecord())).not.toThrow();
  });
});

describe('buildTakedownDraft — impersonation category', () => {
  it('uses cat_ts_impersonation in the report URL', () => {
    const record = { ...fullRecord(), category: 'impersonation' as const };
    const { body } = buildTakedownDraft(record);
    expect(body).toContain('cat_ts_impersonation');
    expect(body).toContain('impersonation');
  });
});

describe('buildTakedownDraft — no external calls', () => {
  it('is a pure function: same input always produces same output', () => {
    const r = fullRecord();
    expect(buildTakedownDraft(r)).toEqual(buildTakedownDraft(r));
  });
});
