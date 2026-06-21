import { describe, expect, it } from 'vitest';

import { buildDayBuckets, dayKey, localDayStartMs } from '../src/scans/stats.js';

const NOW = Date.parse('2026-06-19T12:00:00Z');

// getTimezoneOffset() conventions: US-Eastern (UTC-5) => +300; Cairo (UTC+2) => -120.
const EASTERN = 300;
const CAIRO = -120;

describe('dayKey', () => {
  it('returns the UTC calendar day when offset is 0', () => {
    expect(dayKey(Date.parse('2026-06-19T12:00:00Z'))).toBe('2026-06-19');
    expect(dayKey(Date.parse('2026-06-19T23:59:59Z'))).toBe('2026-06-19');
    expect(dayKey(Date.parse('2026-06-20T00:00:00Z'))).toBe('2026-06-20');
  });

  it('shifts an early-UTC instant back a day for a western viewer', () => {
    // 02:00 UTC on the 20th is still 21:00 on the 19th in US-Eastern.
    expect(dayKey(Date.parse('2026-06-20T02:00:00Z'), EASTERN)).toBe('2026-06-19');
    // ...but 06:00 UTC on the 20th is already the 20th in Eastern.
    expect(dayKey(Date.parse('2026-06-20T06:00:00Z'), EASTERN)).toBe('2026-06-20');
  });

  it('shifts a late-UTC instant forward a day for an eastern viewer', () => {
    // 23:00 UTC on the 19th is 01:00 on the 20th in Cairo (UTC+2).
    expect(dayKey(Date.parse('2026-06-19T23:00:00Z'), CAIRO)).toBe('2026-06-20');
  });
});

describe('localDayStartMs', () => {
  it('is UTC midnight when offset is 0', () => {
    expect(localDayStartMs(NOW)).toBe(Date.parse('2026-06-19T00:00:00Z'));
  });

  it('is the UTC instant of local midnight for a western viewer', () => {
    // Local 2026-06-19 00:00 Eastern == 2026-06-19 05:00 UTC.
    expect(localDayStartMs(NOW, EASTERN)).toBe(Date.parse('2026-06-19T05:00:00Z'));
  });

  it('is the UTC instant of local midnight for an eastern viewer', () => {
    // A 23:00 UTC instant is already the 20th in Cairo; local midnight is 22:00 UTC on the 19th.
    const t = Date.parse('2026-06-19T23:00:00Z');
    expect(localDayStartMs(t, CAIRO)).toBe(Date.parse('2026-06-19T22:00:00Z'));
  });
});

describe('buildDayBuckets', () => {
  it('returns one chronological bucket per day ending today', () => {
    const out = buildDayBuckets([], NOW, 3);
    expect(out.map((b) => b.day)).toEqual(['2026-06-17', '2026-06-18', '2026-06-19']);
    expect(out.every((b) => b.count === 0)).toBe(true);
  });

  it('places counts on the right day and zero-fills the gaps', () => {
    const out = buildDayBuckets(
      [
        { day: '2026-06-19', count: 5 },
        { day: '2026-06-17', count: 2 },
      ],
      NOW,
      3,
    );
    expect(out).toEqual([
      { day: '2026-06-17', count: 2 },
      { day: '2026-06-18', count: 0 },
      { day: '2026-06-19', count: 5 },
    ]);
  });

  it('sums duplicate day rows', () => {
    const out = buildDayBuckets(
      [
        { day: '2026-06-19', count: 1 },
        { day: '2026-06-19', count: 3 },
      ],
      NOW,
      1,
    );
    expect(out).toEqual([{ day: '2026-06-19', count: 4 }]);
  });

  it('ignores rows outside the window', () => {
    const out = buildDayBuckets([{ day: '2026-01-01', count: 99 }], NOW, 2);
    expect(out).toEqual([
      { day: '2026-06-18', count: 0 },
      { day: '2026-06-19', count: 0 },
    ]);
  });
});
