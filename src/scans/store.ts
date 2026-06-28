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

// Delete a user's scan history, for full account erasure (DELETE /api/me).
// Returns the statement so it runs atomically in the account-deletion batch.
export function deleteScansStatement(env: Env, login: string): D1PreparedStatement {
  return env.DB.prepare(`DELETE FROM scans WHERE login = ?`).bind(login);
}

// Retention sweep: drop scan-log rows older than the cutoff so the table can't
// grow without bound. Run daily from the cron. created_at is indexed (0001), so
// this stays cheap. Returns the number of rows removed (for logging).
export async function pruneOldScans(env: Env, olderThan: number): Promise<number> {
  const res = await env.DB.prepare(`DELETE FROM scans WHERE created_at < ?`).bind(olderThan).run();
  return res.meta.changes ?? 0;
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

// Per-day scan counts within [since, now], grouped by the VIEWER's local day.
// `offsetMinutes` is the browser's getTimezoneOffset() value (minutes to add to
// local to reach UTC); shifting the timestamp by -offset before taking the date
// yields the local calendar day. Pair with buildDayBuckets (same offset) to
// zero-fill into a continuous series for the chart.
export async function scansPerDay(
  env: Env,
  since: number,
  offsetMinutes = 0,
): Promise<DayCount[]> {
  const { results } = await env.DB.prepare(
    `SELECT date((created_at / 1000) - (? * 60), 'unixepoch') AS day, COUNT(*) AS count
       FROM scans
      WHERE created_at >= ?
      GROUP BY day
      ORDER BY day`,
  )
    .bind(offsetMinutes, since)
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

// One row in the global scan-audit feed (every user's scans).
export interface ScanAuditItem extends ScanLogItem {
  login: string;
}

// A distinct scanned target, aggregated across all users.
export interface TopScannedItem {
  target: string;
  kind: string;
  scans: number;
  scanners: number; // distinct users who scanned it
  lastScanned: number;
}

// Most-scanned distinct targets (repos/accounts), busiest first. Self-audits and
// clone scans have no target (they cover the caller's own repos) so they're
// excluded. `kind` is functionally determined by the target shape, so SQLite's
// bare-column pick within the GROUP BY returns the correct, constant value.
export async function topScannedTargets(env: Env, limit = 20): Promise<TopScannedItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT target,
            kind,
            COUNT(*) AS scans,
            COUNT(DISTINCT login) AS scanners,
            MAX(created_at) AS last_scanned
       FROM scans
      WHERE target IS NOT NULL AND target <> ''
      GROUP BY target
      ORDER BY scans DESC, last_scanned DESC
      LIMIT ?`,
  )
    .bind(Math.max(1, Math.min(limit, 200)))
    .all<{
      target: string;
      kind: string;
      scans: number;
      scanners: number;
      last_scanned: number;
    }>();
  return (results ?? []).map((r) => ({
    target: r.target,
    kind: r.kind,
    scans: r.scans,
    scanners: r.scanners,
    lastScanned: r.last_scanned,
  }));
}

// Most recent scans across ALL users, newest first, optionally filtered by kind.
// Powers the admin "Scan log" audit view.
export async function listRecentScans(
  env: Env,
  args: { kind?: ScanKind; limit: number },
): Promise<ScanAuditItem[]> {
  const limit = Math.max(1, Math.min(args.limit, 500));
  const stmt = args.kind
    ? env.DB.prepare(
        `SELECT login, kind, target, top_score, created_at FROM scans WHERE kind = ? ORDER BY created_at DESC LIMIT ?`,
      ).bind(args.kind, limit)
    : env.DB.prepare(
        `SELECT login, kind, target, top_score, created_at FROM scans ORDER BY created_at DESC LIMIT ?`,
      ).bind(limit);
  const { results } = await stmt.all<{
    login: string;
    kind: string;
    target: string | null;
    top_score: number | null;
    created_at: number;
  }>();
  return (results ?? []).map((r) => ({
    login: r.login,
    kind: r.kind,
    target: r.target,
    topScore: r.top_score,
    createdAt: r.created_at,
  }));
}
