import { randomToken } from '../auth/crypto.js';
import type { Env } from '../env.js';

export type AuditAction =
  | 'login'
  | 'suspend_user'
  | 'unsuspend_user'
  | 'set_role'
  | 'update_message'
  | 'reply_message'
  | 'update_report';

// Audit view filter: sign-ins vs admin actions (everything that isn't a login).
export type AuditCategory = 'all' | 'logins' | 'actions';

export interface AuditRecord {
  id: string;
  adminLogin: string;
  action: AuditAction;
  target: string | null;
  detail: string | null;
  createdAt: number;
}

interface AuditRow {
  id: string;
  admin_login: string;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: number;
}

// Record an admin action. Best-effort: failures here must never break the action
// they describe, so callers wrap this in ctx.waitUntil / a swallowed catch.
export async function recordAudit(
  env: Env,
  args: { adminLogin: string; action: AuditAction; target: string | null; detail: string | null; now: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO admin_audit (id, admin_login, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(randomToken(12), args.adminLogin, args.action, args.target, args.detail, args.now)
    .run();
}

export async function listAudit(
  env: Env,
  args: { limit?: number; category?: AuditCategory } = {},
): Promise<AuditRecord[]> {
  const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
  // 'logins' → only sign-ins; 'actions' → everything else; 'all' → no filter.
  const where =
    args.category === 'logins'
      ? `WHERE action = 'login'`
      : args.category === 'actions'
        ? `WHERE action <> 'login'`
        : '';
  const { results } = await env.DB.prepare(
    `SELECT * FROM admin_audit ${where} ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<AuditRow>();
  return (results ?? []).map((row) => ({
    id: row.id,
    adminLogin: row.admin_login,
    action: row.action as AuditAction,
    target: row.target,
    detail: row.detail,
    createdAt: row.created_at,
  }));
}
