// Pure shaping for the analytics dashboard. The store does the COUNT/GROUP BY in
// SQL; this fills the gaps so a sparse "scans per day" result becomes a
// continuous, zero-filled series the chart can render directly. `now` is a
// parameter (not Date.now()) so the bucketing is deterministic under test.

export interface DayCount {
  day: string; // UTC YYYY-MM-DD
  count: number;
}

// UTC calendar day for a millisecond timestamp.
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Return one bucket per day for the trailing `days` days ending on `now`'s UTC
// day, in chronological order, with counts taken from `rows` (any day missing
// from `rows` becomes 0). Days outside the window in `rows` are ignored.
export function buildDayBuckets(rows: DayCount[], now: number, days: number): DayCount[] {
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.count);

  const out: DayCount[] = [];
  // Start at the oldest day in the window and walk forward to today.
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dayKey(now - i * DAY_MS);
    out.push({ day: key, count: byDay.get(key) ?? 0 });
  }
  return out;
}
