import type { Env } from '../env.js';
import type { ScanKind } from '../admin/constants.js';
import type { DayCount } from './stats.js';

// Aggregate-only scan accounting. We deliberately do NOT keep a per-scan,
// identity-linked log (who scanned what, when): the only durable record of scan
// activity is an anonymous per-day, per-kind counter (scan_daily) plus the
// user's own scan_count. Abuse "velocity" is derived separately from rate_events
// (bucket 'scan-day:<login>'), see src/users/store.ts.

// UTC calendar day ('YYYY-MM-DD') for a millisecond timestamp. Matches the
// `date(created_at/1000,'unixepoch')` bucketing the 0006 backfill used, so live
// counters and backfilled history share the same day keys.
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Record a completed scan in one batch: increment today's (UTC) per-kind
// aggregate and bump the user's activity counters. No target/score/identity is
// stored. Best-effort: callers run this via ctx.waitUntil so it never delays a
// response.
export async function recordScan(
  env: Env,
  args: { login: string; kind: ScanKind; now: number },
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO scan_daily (day, kind, count) VALUES (?, ?, 1)
         ON CONFLICT(day, kind) DO UPDATE SET count = count + 1`,
    ).bind(utcDay(args.now), args.kind),
    env.DB.prepare(`UPDATE users SET scan_count = scan_count + 1, last_seen_at = ? WHERE login = ?`).bind(
      args.now,
      args.login,
    ),
  ]);
}

export async function countAllScans(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM scan_daily`).first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

// Total scans on/after the UTC day containing `since`. The aggregate is bucketed
// by whole UTC days (it has no per-event timestamp), so a sub-day `since` widens
// to that day's start: the dashboard's rolling 24h/7d windows become "since the
// start of the UTC day N days ago".
export async function countScansSince(env: Env, since: number): Promise<number> {
  const row = await env.DB.prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM scan_daily WHERE day >= ?`)
    .bind(utcDay(since))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countScansByKind(env: Env): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare(
    `SELECT kind, SUM(count) AS count FROM scan_daily GROUP BY kind`,
  ).all<{ kind: string; count: number }>();
  const out: Record<string, number> = {};
  for (const r of results ?? []) out[r.kind] = r.count;
  return out;
}

// Per-day scan totals on/after the UTC day containing `since`, oldest first.
// Days are whole UTC days — the aggregate has no per-event timestamp, so the old
// per-viewer timezone shifting is no longer possible and the chart is UTC-based.
// Pair with buildDayBuckets to zero-fill into a continuous series for the chart.
export async function scansPerDay(env: Env, since: number): Promise<DayCount[]> {
  const { results } = await env.DB.prepare(
    `SELECT day, SUM(count) AS count
       FROM scan_daily
      WHERE day >= ?
      GROUP BY day
      ORDER BY day`,
  )
    .bind(utcDay(since))
    .all<{ day: string; count: number }>();
  return results ?? [];
}
