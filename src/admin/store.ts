import type { Env } from '../env.js';
import { buildDayBuckets, localDayStartMs } from '../scans/stats.js';
import type { DayCount } from '../scans/stats.js';
import {
  countAllScans,
  countScansByKind,
  countScansSince,
  scansPerDay,
} from '../scans/store.js';
import { countMessagesByStatus } from '../messages/store.js';
import { countReportsByStatus, topReportedRepos } from '../reports/store.js';

const DAY = 24 * 60 * 60 * 1000;
const CHART_DAYS = 14;

export interface AdminStats {
  generatedAt: number;
  users: {
    total: number;
    suspended: number;
    admins: number;
    active7d: number;
    active30d: number;
    new7d: number;
    newToday: number;
  };
  scans: {
    total: number;
    last24h: number;
    last7d: number;
    byKind: Record<string, number>;
    perDay: DayCount[];
  };
  messages: { open: number; read: number; resolved: number; total: number };
  reports: {
    total: number;
    byStatus: Record<string, number>;
    topReported: { suspectRepo: string; reporters: number }[];
  };
}

async function countWhere(env: Env, sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// One shot to build the whole overview. Runs the cheap aggregates concurrently.
// `offsetMinutes` is the viewer's getTimezoneOffset(), so calendar-day metrics
// (the per-day chart and "new today") align to the admin's local midnight rather
// than UTC. Rolling windows (24h/7d/30d) are timezone-independent and unchanged.
export async function getAdminStats(env: Env, now: number, offsetMinutes = 0): Promise<AdminStats> {
  const since24h = now - DAY;
  const since7d = now - 7 * DAY;
  const since30d = now - 30 * DAY;
  const startOfToday = localDayStartMs(now, offsetMinutes);

  const [
    total,
    suspended,
    admins,
    active7d,
    active30d,
    new7d,
    newToday,
    scansTotal,
    scans24h,
    scans7d,
    byKind,
    perDayRaw,
    msgCounts,
    reportCounts,
    topReported,
  ] = await Promise.all([
    countWhere(env, `SELECT COUNT(*) AS n FROM users`),
    countWhere(env, `SELECT COUNT(*) AS n FROM users WHERE suspended_at IS NOT NULL`),
    countWhere(env, `SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`),
    countWhere(env, `SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= ?`, since7d),
    countWhere(env, `SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= ?`, since30d),
    countWhere(env, `SELECT COUNT(*) AS n FROM users WHERE first_seen_at >= ?`, since7d),
    countWhere(env, `SELECT COUNT(*) AS n FROM users WHERE first_seen_at >= ?`, startOfToday),
    countAllScans(env),
    countScansSince(env, since24h),
    countScansSince(env, since7d),
    countScansByKind(env),
    scansPerDay(env, now - CHART_DAYS * DAY, offsetMinutes),
    countMessagesByStatus(env),
    countReportsByStatus(env),
    topReportedRepos(env, 8),
  ]);

  const reportsTotal = Object.values(reportCounts).reduce((a, b) => a + b, 0);

  return {
    generatedAt: now,
    users: { total, suspended, admins, active7d, active30d, new7d, newToday },
    scans: {
      total: scansTotal,
      last24h: scans24h,
      last7d: scans7d,
      byKind,
      perDay: buildDayBuckets(perDayRaw, now, CHART_DAYS, offsetMinutes),
    },
    messages: { ...msgCounts, total: msgCounts.open + msgCounts.read + msgCounts.resolved },
    reports: { total: reportsTotal, byStatus: reportCounts, topReported },
  };
}
