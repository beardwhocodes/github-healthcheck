import { randomToken } from '../auth/crypto.js';
import type { Env } from '../env.js';
import type { AbuseCategory, ReportStatus } from '../admin/constants.js';

export interface ReportRecord {
  id: string;
  reporterLogin: string;
  suspectRepo: string;
  suspectUrl: string | null;
  sourceRepo: string | null;
  confidence: number | null;
  category: AbuseCategory | null;
  status: ReportStatus;
  adminNotes: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ReportRow {
  id: string;
  reporter_login: string;
  suspect_repo: string;
  suspect_url: string | null;
  source_repo: string | null;
  confidence: number | null;
  category: string | null;
  status: string;
  admin_notes: string | null;
  created_at: number;
  updated_at: number;
}

function rowToReport(row: ReportRow): ReportRecord {
  return {
    id: row.id,
    reporterLogin: row.reporter_login,
    suspectRepo: row.suspect_repo,
    suspectUrl: row.suspect_url,
    sourceRepo: row.source_repo,
    confidence: row.confidence,
    category: (row.category as AbuseCategory | null) ?? null,
    status: (row.status as ReportStatus) ?? 'reported',
    adminNotes: row.admin_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Record (or refresh) a user's report of a suspect repo. De-duped per
// (reporter, suspect) so repeated clicks update the timestamp instead of piling
// up rows; the admin-set status/notes are preserved on conflict.
export async function recordReport(
  env: Env,
  args: {
    reporterLogin: string;
    suspectRepo: string;
    suspectUrl: string | null;
    sourceRepo: string | null;
    confidence: number | null;
    category: AbuseCategory | null;
    now: number;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO reported_repos
       (id, reporter_login, suspect_repo, suspect_url, source_repo, confidence, category, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'reported', ?, ?)
     ON CONFLICT(reporter_login, suspect_repo) DO UPDATE SET
       suspect_url = excluded.suspect_url,
       source_repo = excluded.source_repo,
       confidence = excluded.confidence,
       category = excluded.category,
       updated_at = excluded.updated_at`,
  )
    .bind(
      randomToken(12),
      args.reporterLogin,
      args.suspectRepo,
      args.suspectUrl,
      args.sourceRepo,
      args.confidence,
      args.category,
      args.now,
      args.now,
    )
    .run();
}

// Delete the repos a user reported, for full account erasure (DELETE /api/me).
// Returns the statement so it runs atomically in the account-deletion batch.
export function deleteReportsStatement(env: Env, login: string): D1PreparedStatement {
  return env.DB.prepare(`DELETE FROM reported_repos WHERE reporter_login = ?`).bind(login);
}

export async function getReport(env: Env, id: string): Promise<ReportRecord | null> {
  const row = await env.DB.prepare(`SELECT * FROM reported_repos WHERE id = ?`)
    .bind(id)
    .first<ReportRow>();
  return row ? rowToReport(row) : null;
}

export async function listReports(
  env: Env,
  args: { status?: ReportStatus; limit: number },
): Promise<ReportRecord[]> {
  const limit = Math.max(1, Math.min(args.limit, 500));
  const stmt = args.status
    ? env.DB.prepare(
        `SELECT * FROM reported_repos WHERE status = ? ORDER BY updated_at DESC LIMIT ?`,
      ).bind(args.status, limit)
    : env.DB.prepare(`SELECT * FROM reported_repos ORDER BY updated_at DESC LIMIT ?`).bind(limit);
  const { results } = await stmt.all<ReportRow>();
  return (results ?? []).map(rowToReport);
}

export async function countReportsByStatus(env: Env): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS count FROM reported_repos GROUP BY status`,
  ).all<{ status: string; count: number }>();
  const out: Record<string, number> = {};
  for (const r of results ?? []) out[r.status] = r.count;
  return out;
}

// Distinct suspect repos reported by the most people bubble up as higher-signal.
// (Status is intentionally omitted — a GROUP BY can't pick one meaningful status
// across a cluster, and the overview only needs the reporter count.)
export async function topReportedRepos(
  env: Env,
  limit = 10,
): Promise<{ suspectRepo: string; reporters: number }[]> {
  const { results } = await env.DB.prepare(
    `SELECT suspect_repo,
            COUNT(DISTINCT reporter_login) AS reporters
       FROM reported_repos
      GROUP BY suspect_repo
      ORDER BY reporters DESC, MAX(updated_at) DESC
      LIMIT ?`,
  )
    .bind(Math.max(1, Math.min(limit, 50)))
    .all<{ suspect_repo: string; reporters: number }>();
  return (results ?? []).map((r) => ({
    suspectRepo: r.suspect_repo,
    reporters: r.reporters,
  }));
}

export async function updateReport(
  env: Env,
  args: { id: string; status?: ReportStatus; notes?: string; now: number },
): Promise<void> {
  const sets: string[] = ['updated_at = ?'];
  const binds: unknown[] = [args.now];
  if (args.status !== undefined) {
    sets.push('status = ?');
    binds.push(args.status);
  }
  if (args.notes !== undefined) {
    sets.push('admin_notes = ?');
    binds.push(args.notes);
  }
  binds.push(args.id);
  await env.DB.prepare(`UPDATE reported_repos SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
}
