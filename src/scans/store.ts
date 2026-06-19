import { randomToken } from '../auth/crypto.js';
import type { Env } from '../env.js';
import type { ScanKind } from '../admin/constants.js';
import type { DayCount } from './stats.js';

// Log a completed scan and bump the user's activity counters in one batch.
// Best-effort: callers run this via ctx.waitUntil so it never delays a response.
export async function recordScan(
  env: Env,
  args: { login: string; kind: ScanKind; target: string | null; topScore: number | null; now: number },
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO scans (id, login, kind, target, top_score, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(randomToken(12), args.login, args.kind, args.target, args.topScore, args.now),
    env.DB.prepare(`UPDATE users SET scan_count = scan_count + 1, last_seen_at = ? WHERE login = ?`).bind(
      args.now,
      args.login,
    ),
  ]);
}

export async function countScansSince(env: Env, since: number): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM scans WHERE created_at >= ?`)
    .bind(since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countAllScans(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM scans`).first<{ n: number }>();
  return row?.n ?? 0;
}

// Per-UTC-day scan counts within [since, now]; pair with buildDayBuckets to
// zero-fill into a continuous series for the chart.
export async function scansPerDay(env: Env, since: number): Promise<DayCount[]> {
  const { results } = await env.DB.prepare(
    `SELECT substr(datetime(created_at / 1000, 'unixepoch'), 1, 10) AS day, COUNT(*) AS count
       FROM scans
      WHERE created_at >= ?
      GROUP BY day
      ORDER BY day`,
  )
    .bind(since)
    .all<{ day: string; count: number }>();
  return results ?? [];
}

export async function countScansByKind(env: Env): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare(
    `SELECT kind, COUNT(*) AS count FROM scans GROUP BY kind`,
  ).all<{ kind: string; count: number }>();
  const out: Record<string, number> = {};
  for (const r of results ?? []) out[r.kind] = r.count;
  return out;
}

export interface ScanLogItem {
  kind: string;
  target: string | null;
  topScore: number | null;
  createdAt: number;
}

// Most recent scans for one user (admin drill-down).
export async function recentScansForUser(env: Env, login: string, limit = 20): Promise<ScanLogItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT kind, target, top_score, created_at FROM scans WHERE login = ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(login, Math.max(1, Math.min(limit, 100)))
    .all<{ kind: string; target: string | null; top_score: number | null; created_at: number }>();
  return (results ?? []).map((r) => ({
    kind: r.kind,
    target: r.target,
    topScore: r.top_score,
    createdAt: r.created_at,
  }));
}
