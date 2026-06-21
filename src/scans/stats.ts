// Pure shaping for the analytics dashboard. The store does the COUNT/GROUP BY in
// SQL; this fills the gaps so a sparse "scans per day" result becomes a
// continuous, zero-filled series the chart can render directly. `now` is a
// parameter (not Date.now()) so the bucketing is deterministic under test.
//
// Day boundaries are computed in the VIEWER's timezone via `offsetMinutes` — the
// value from the browser's `Date.prototype.getTimezoneOffset()` (minutes to ADD
// to local time to reach UTC: +300 for US-Eastern, -120 for Cairo). Local
// wall-clock for a UTC instant `ms` is therefore `ms - offsetMinutes*60000`.
// offsetMinutes defaults to 0 (UTC) so callers that don't pass it are unchanged.

export interface DayCount {
  day: string; // YYYY-MM-DD in the viewer's local day (UTC when offset is 0)
  count: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

// The viewer's local calendar day (YYYY-MM-DD) for a UTC millisecond timestamp.
export function dayKey(ms: number, offsetMinutes = 0): string {
  return new Date(ms - offsetMinutes * MIN_MS).toISOString().slice(0, 10);
}

// The UTC millisecond instant at which the viewer's local calendar day (the one
// containing `now`) begins. Used to count "new today" against a local midnight.
export function localDayStartMs(now: number, offsetMinutes = 0): number {
  const localMidnightAsUtc = Date.parse(`${dayKey(now, offsetMinutes)}T00:00:00Z`);
  // That instant is local-midnight read as if UTC; the true UTC instant is it
  // plus the offset (UTC = local + offset).
  return localMidnightAsUtc + offsetMinutes * MIN_MS;
}

// Return one bucket per day for the trailing `days` days ending on `now`'s local
// day, in chronological order, with counts taken from `rows` (any day missing
// from `rows` becomes 0). Days outside the window in `rows` are ignored. `rows`
// must already be keyed in the same local day as `offsetMinutes` produces.
export function buildDayBuckets(
  rows: DayCount[],
  now: number,
  days: number,
  offsetMinutes = 0,
): DayCount[] {
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.count);

  const out: DayCount[] = [];
  // Start at the oldest day in the window and walk forward to today.
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dayKey(now - i * DAY_MS, offsetMinutes);
    out.push({ day: key, count: byDay.get(key) ?? 0 });
  }
  return out;
}
