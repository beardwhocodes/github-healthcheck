import { randomToken } from '../auth/crypto.js';
import type { Env, UserRecord } from '../env.js';
import { isBootstrapAdmin } from '../admin/policy.js';
import { parseAdminLogins } from '../admin/constants.js';
import type { Role } from '../admin/constants.js';
import type { AuditAction } from '../admin/audit.js';

interface UserRow {
  login: string;
  name: string | null;
  avatar_url: string | null;
  role: string;
  suspended_at: number | null;
  suspended_reason: string | null;
  suspended_by: string | null;
  includes_private: number;
  scan_count: number;
  first_seen_at: number;
  last_seen_at: number;
}

function rowToUser(row: UserRow): UserRecord {
  return {
    login: row.login,
    name: row.name,
    avatarUrl: row.avatar_url,
    role: row.role === 'admin' ? 'admin' : 'user',
    suspendedAt: row.suspended_at,
    suspendedReason: row.suspended_reason,
    suspendedBy: row.suspended_by,
    includesPrivate: row.includes_private,
    scanCount: row.scan_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function initialRole(login: string, bootstrapAdmins: readonly string[]): Role {
  return isBootstrapAdmin(login, bootstrapAdmins) ? 'admin' : 'user';
}

// Build the admin_audit INSERT so an admin mutation and its accountability row
// commit (or fail) together in one D1 batch. A separate post-commit audit write
// — especially a swallowed one — can lose the record of who changed what.
function auditStatement(
  env: Env,
  args: { adminLogin: string; action: AuditAction; target: string | null; detail: string | null; now: number },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO admin_audit (id, admin_login, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(randomToken(12), args.adminLogin, args.action, args.target, args.detail, args.now);
}

// Hard-delete the user's identity row, for full account erasure (DELETE
// /api/me). Returns the statement (rather than running it) so the caller can run
// it atomically in one D1 batch alongside the other stores' deletions.
export function deleteUserStatement(env: Env, login: string): D1PreparedStatement {
  return env.DB.prepare(`DELETE FROM users WHERE login = ?`).bind(login);
}

export async function getUser(env: Env, login: string): Promise<UserRecord | null> {
  const row = await env.DB.prepare(`SELECT * FROM users WHERE login = ?`)
    .bind(login)
    .first<UserRow>();
  return row ? rowToUser(row) : null;
}

// Authoritative upsert on sign-in: refreshes profile + scope + last_seen, and
// (re)asserts the admin role for bootstrap logins. Creates the row if new.
export async function upsertUserOnLogin(
  env: Env,
  args: { login: string; name: string | null; avatarUrl: string; includesPrivate: boolean; now: number },
): Promise<void> {
  const role = initialRole(args.login, parseAdminLogins(env.ADMIN_LOGINS));
  const priv = args.includesPrivate ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO users (login, name, avatar_url, role, includes_private, scan_count, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(login) DO UPDATE SET
       name = excluded.name,
       avatar_url = excluded.avatar_url,
       includes_private = excluded.includes_private,
       last_seen_at = excluded.last_seen_at,
       -- never downgrade a stored admin; always (re)promote a bootstrap admin
       role = CASE WHEN ? = 'admin' THEN 'admin' ELSE users.role END`,
  )
    .bind(args.login, args.name, args.avatarUrl, role, priv, args.now, args.now, role)
    .run();
}

// Ensure a row exists for an already-authenticated session (covers sessions
// minted before the users table existed). Cheap: one SELECT, INSERT only if
// missing. Does not bump last_seen (login + scans own that signal). The
// privacy posture is taken from the live session scope so the durable record
// matches the session that created it (upsertUserOnLogin refreshes it on login).
export async function ensureUser(
  env: Env,
  args: {
    login: string;
    name: string | null;
    avatarUrl: string | null;
    includesPrivate: boolean;
    now: number;
  },
): Promise<UserRecord> {
  const existing = await getUser(env, args.login);
  if (existing) return existing;

  const role = initialRole(args.login, parseAdminLogins(env.ADMIN_LOGINS));
  const priv = args.includesPrivate ? 1 : 0;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (login, name, avatar_url, role, includes_private, scan_count, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(args.login, args.name, args.avatarUrl, role, priv, args.now, args.now)
    .run();

  // Re-read so a row that lost the INSERT race is still returned correctly.
  const created = await getUser(env, args.login);
  return (
    created ?? {
      login: args.login,
      name: args.name,
      avatarUrl: args.avatarUrl,
      role,
      suspendedAt: null,
      suspendedReason: null,
      suspendedBy: null,
      includesPrivate: priv,
      scanCount: 0,
      firstSeenAt: args.now,
      lastSeenAt: args.now,
    }
  );
}

// The state change and its audit row go in one atomic batch (see auditStatement).
export async function suspendUser(
  env: Env,
  args: { login: string; reason: string; by: string; now: number },
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET suspended_at = ?, suspended_reason = ?, suspended_by = ? WHERE login = ?`,
    ).bind(args.now, args.reason, args.by, args.login),
    auditStatement(env, {
      adminLogin: args.by,
      action: 'suspend_user',
      target: args.login,
      detail: args.reason,
      now: args.now,
    }),
  ]);
}

export async function unsuspendUser(
  env: Env,
  args: { login: string; by: string; now: number },
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET suspended_at = NULL, suspended_reason = NULL, suspended_by = NULL WHERE login = ?`,
    ).bind(args.login),
    auditStatement(env, {
      adminLogin: args.by,
      action: 'unsuspend_user',
      target: args.login,
      detail: null,
      now: args.now,
    }),
  ]);
}

export async function setUserRole(
  env: Env,
  args: { login: string; role: Role; by: string; now: number },
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET role = ? WHERE login = ?`).bind(args.role, args.login),
    auditStatement(env, {
      adminLogin: args.by,
      action: 'set_role',
      target: args.login,
      detail: args.role,
      now: args.now,
    }),
  ]);
}

export interface UserListItem extends UserRecord {
  recentScans: number; // scans in the trailing 24h
}

export interface UserListFilter {
  query?: string;
  status?: 'all' | 'active' | 'suspended' | 'admin';
  since24h: number; // now - 24h, for the velocity join
  limit: number;
}

// Escape LIKE metacharacters (% and _) and the escape char itself so a user's
// search term is matched literally. Pairs with `ESCAPE '\'` in the query.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// Pure query builder, extracted so the positional-bind bookkeeping (the classic
// off-by-one when a filter is added) is unit-testable without a DB. Placeholder
// order MUST be: the velocity-window `?` (subquery), then any search `?`s
// (WHERE), then the LIMIT `?`. The binds array mirrors exactly that order.
//
// Velocity (a user's scans in the trailing 24h) is read from rate_events, NOT a
// per-scan log: the rate limiter records one row per accepted scan under bucket
// 'scan-day:<login>' (the 'scan-day:' prefix is 9 chars, so substr(.,10) is the
// login). This keeps the abuse signal without retaining an identity-linked scan
// history. Admins are exempt from rate limiting, so they have no such rows and
// always read 0 here — acceptable, since velocity only flags non-admin abuse.
export function buildUserListQuery(filter: UserListFilter): { sql: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [filter.since24h];

  if (filter.query) {
    // Match the query as a literal substring: escape LIKE metacharacters so a '%'
    // or '_' typed into the search box matches itself instead of acting as a
    // wildcard. ESCAPE '\' tells SQLite the backslash is the escape character.
    where.push(`(u.login LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')`);
    const pattern = `%${escapeLike(filter.query)}%`;
    binds.push(pattern, pattern);
  }
  if (filter.status === 'suspended') where.push(`u.suspended_at IS NOT NULL`);
  else if (filter.status === 'active') where.push(`u.suspended_at IS NULL`);
  else if (filter.status === 'admin') where.push(`u.role = 'admin'`);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  binds.push(Math.max(1, Math.min(filter.limit, 500)));

  const sql = `SELECT u.*, COALESCE(rv.recent, 0) AS recent_scans
       FROM users u
       LEFT JOIN (
         SELECT substr(bucket, 10) AS login, COUNT(*) AS recent
           FROM rate_events
          WHERE bucket LIKE 'scan-day:%' AND created_at >= ?
          GROUP BY bucket
       ) rv ON rv.login = u.login
       ${whereSql}
       ORDER BY u.last_seen_at DESC
       LIMIT ?`;

  return { sql, binds };
}

export async function listUsers(env: Env, filter: UserListFilter): Promise<UserListItem[]> {
  const { sql, binds } = buildUserListQuery(filter);
  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all<UserRow & { recent_scans: number }>();

  return (results ?? []).map((row) => ({ ...rowToUser(row), recentScans: row.recent_scans }));
}
