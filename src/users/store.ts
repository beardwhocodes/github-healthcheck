import type { Env, UserRecord } from '../env.js';
import { isBootstrapAdmin } from '../admin/policy.js';
import type { Role } from '../admin/constants.js';

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

function initialRole(login: string): Role {
  return isBootstrapAdmin(login) ? 'admin' : 'user';
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
  const role = initialRole(args.login);
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

  const role = initialRole(args.login);
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

export async function suspendUser(
  env: Env,
  args: { login: string; reason: string; by: string; now: number },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE users SET suspended_at = ?, suspended_reason = ?, suspended_by = ? WHERE login = ?`,
  )
    .bind(args.now, args.reason, args.by, args.login)
    .run();
}

export async function unsuspendUser(env: Env, login: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE users SET suspended_at = NULL, suspended_reason = NULL, suspended_by = NULL WHERE login = ?`,
  )
    .bind(login)
    .run();
}

export async function setUserRole(env: Env, login: string, role: Role): Promise<void> {
  await env.DB.prepare(`UPDATE users SET role = ? WHERE login = ?`).bind(role, login).run();
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

// Pure query builder, extracted so the positional-bind bookkeeping (the classic
// off-by-one when a filter is added) is unit-testable without a DB. Placeholder
// order MUST be: the velocity-window `?` (subquery), then any search `?`s
// (WHERE), then the LIMIT `?`. The binds array mirrors exactly that order.
export function buildUserListQuery(filter: UserListFilter): { sql: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [filter.since24h];

  if (filter.query) {
    where.push(`(u.login LIKE ? OR u.name LIKE ?)`);
    binds.push(`%${filter.query}%`, `%${filter.query}%`);
  }
  if (filter.status === 'suspended') where.push(`u.suspended_at IS NOT NULL`);
  else if (filter.status === 'active') where.push(`u.suspended_at IS NULL`);
  else if (filter.status === 'admin') where.push(`u.role = 'admin'`);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  binds.push(Math.max(1, Math.min(filter.limit, 500)));

  const sql = `SELECT u.*, COALESCE(s.recent, 0) AS recent_scans
       FROM users u
       LEFT JOIN (
         SELECT login, COUNT(*) AS recent FROM scans WHERE created_at >= ? GROUP BY login
       ) s ON s.login = u.login
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
