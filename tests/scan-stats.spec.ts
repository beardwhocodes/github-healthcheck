import { describe, expect, it } from 'vitest';

import { buildDayBuckets, dayKey } from '../src/scans/stats.js';

const NOW = Date.parse('2026-06-19T12:00:00Z');

describe('dayKey', () => {
  it('returns the UTC calendar day', () => {
    expect(dayKey(Date.parse('2026-06-19T12:00:00Z'))).toBe('2026-06-19');
    expect(dayKey(Date.parse('2026-06-19T23:59:59Z'))).toBe('2026-06-19');
    expect(dayKey(Date.parse('2026-06-20T00:00:00Z'))).toBe('2026-06-20');
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
