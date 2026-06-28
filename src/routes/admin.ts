import { Hono } from 'hono';
import type { Context } from 'hono';

import type { Env } from '../env.js';
import { requireAdmin } from './middleware.js';
import type { Vars } from './middleware.js';
import {
  canSetRole,
  canSuspend,
  canUnsuspend,
  isValidMessageStatus,
  isValidReportStatus,
  isValidRole,
  scanVelocityBand,
} from '../admin/policy.js';
import { getAdminStats } from '../admin/store.js';
import { listAudit, recordAudit } from '../admin/audit.js';
import type { AuditAction } from '../admin/audit.js';
import {
  getUser,
  listUsers,
  setUserRole,
  suspendUser,
  unsuspendUser,
} from '../users/store.js';
import { listRecentScans, recentScansForUser, topScannedTargets } from '../scans/store.js';
import { SCAN_KINDS, parseAdminLogins } from '../admin/constants.js';
import type { ScanKind } from '../admin/constants.js';
import {
  getMessage,
  listMessages,
  replyToMessage,
  updateMessageStatus,
} from '../messages/store.js';
import type { MessageStatus } from '../admin/constants.js';
import { getReport, listReports, updateReport } from '../reports/store.js';
import type { ReportStatus } from '../admin/constants.js';
import { sendContactReply } from '../alerts/email.js';

export const admin = new Hono<{ Bindings: Env; Variables: Vars }>();

// Every route here is admin-only. Mounted under the already-authenticated /api,
// so c.get('user') is present and trustworthy.
admin.use('*', requireAdmin);

const DAY = 24 * 60 * 60 * 1000;

// Record an admin action before responding. Awaited (not fire-and-forget) so a
// failed write surfaces as an error rather than silently dropping the
// accountability row. The user mutations (suspend/unsuspend/role) instead write
// their audit row atomically inside the same D1 batch as the change itself; this
// helper covers the message/report actions whose stores live elsewhere.
function audit(
  c: Context<{ Bindings: Env; Variables: Vars }>,
  action: AuditAction,
  target: string | null,
  detail: string | null,
): Promise<void> {
  return recordAudit(c.env, {
    adminLogin: c.get('user').login,
    action,
    target,
    detail,
    now: Date.now(),
  });
}

// ── Overview ──────────────────────────────────────────────────────────────
admin.get('/stats', async (c) => {
  // Viewer's UTC offset (minutes, getTimezoneOffset() convention) so calendar-day
  // metrics render in their local timezone. Clamp to the real-world ±14h range.
  const raw = Number(c.req.query('tzOffset'));
  const offsetMinutes = Number.isFinite(raw) ? Math.max(-840, Math.min(840, Math.trunc(raw))) : 0;
  const stats = await getAdminStats(c.env, Date.now(), offsetMinutes);
  return c.json(stats);
});

// ── Scan log (audit of what's been scanned, across all users) ─────────────
admin.get('/scans', async (c) => {
  const kindParam = c.req.query('kind');
  const kind = (SCAN_KINDS as readonly string[]).includes(kindParam ?? '')
    ? (kindParam as ScanKind)
    : undefined;
  const limit = Number(c.req.query('limit') ?? 200) || 200;
  const scans = await listRecentScans(c.env, { kind, limit });
  return c.json({ scans });
});

// Most-scanned distinct targets (repos/accounts), busiest first.
admin.get('/scans/top', async (c) => {
  const limit = Number(c.req.query('limit') ?? 50) || 50;
  const targets = await topScannedTargets(c.env, limit);
  return c.json({ targets });
});

// ── Users ─────────────────────────────────────────────────────────────────
admin.get('/users', async (c) => {
  const query = c.req.query('query')?.trim() || undefined;
  const statusParam = c.req.query('status');
  const status =
    statusParam === 'active' || statusParam === 'suspended' || statusParam === 'admin'
      ? statusParam
      : 'all';
  const limit = Number(c.req.query('limit') ?? 100) || 100;

  const users = await listUsers(c.env, { query, status, since24h: Date.now() - DAY, limit });
  return c.json({
    users: users.map((u) => ({ ...u, velocity: scanVelocityBand(u.recentScans) })),
  });
});

admin.get('/users/:login', async (c) => {
  const target = await getUser(c.env, c.req.param('login'));
  if (!target) return c.json({ error: 'not_found' }, 404);
  const recentScans = await recentScansForUser(c.env, target.login, 25);
  return c.json({ user: target, recentScans });
});

admin.post('/users/:login/suspend', async (c) => {
  const actor = c.get('user');
  const target = await getUser(c.env, c.req.param('login'));
  if (!target) return c.json({ error: 'not_found' }, 404);

  const decision = canSuspend(actor, target, parseAdminLogins(c.env.ADMIN_LOGINS));
  if (!decision.ok) return c.json({ error: 'forbidden', message: decision.reason }, 403);

  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
  const reason = (body.reason ?? '').trim().slice(0, 500) || 'Policy violation.';

  // suspendUser writes the audit row in the same atomic batch as the suspension.
  await suspendUser(c.env, { login: target.login, reason, by: actor.login, now: Date.now() });
  const updated = await getUser(c.env, target.login);
  if (!updated) return c.json({ error: 'not_found' }, 404);
  return c.json({ user: updated });
});

admin.post('/users/:login/unsuspend', async (c) => {
  const actor = c.get('user');
  const decision = canUnsuspend(actor, parseAdminLogins(c.env.ADMIN_LOGINS));
  if (!decision.ok) return c.json({ error: 'forbidden', message: decision.reason }, 403);

  const target = await getUser(c.env, c.req.param('login'));
  if (!target) return c.json({ error: 'not_found' }, 404);

  await unsuspendUser(c.env, { login: target.login, by: actor.login, now: Date.now() });
  const updated = await getUser(c.env, target.login);
  if (!updated) return c.json({ error: 'not_found' }, 404);
  return c.json({ user: updated });
});

admin.post('/users/:login/role', async (c) => {
  const actor = c.get('user');
  const target = await getUser(c.env, c.req.param('login'));
  if (!target) return c.json({ error: 'not_found' }, 404);

  const body = await c.req.json<{ role?: string }>().catch(() => ({}) as { role?: string });
  const role = body.role ?? '';

  const decision = canSetRole(actor, target, role, parseAdminLogins(c.env.ADMIN_LOGINS));
  if (!decision.ok) return c.json({ error: 'forbidden', message: decision.reason }, 403);
  if (!isValidRole(role)) return c.json({ error: 'bad_request', message: 'Unknown role.' }, 400);

  await setUserRole(c.env, { login: target.login, role, by: actor.login, now: Date.now() });
  const updated = await getUser(c.env, target.login);
  if (!updated) return c.json({ error: 'not_found' }, 404);
  return c.json({ user: updated });
});

// ── Support inbox ────────────────────────────────────────────────────────
admin.get('/messages', async (c) => {
  const statusParam = c.req.query('status');
  const status: MessageStatus | undefined = isValidMessageStatus(statusParam ?? '')
    ? (statusParam as MessageStatus)
    : undefined;
  const messages = await listMessages(c.env, { status, limit: 200 });
  return c.json({ messages });
});

admin.post('/messages/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await getMessage(c.env, id);
  if (!existing) return c.json({ error: 'not_found' }, 404);

  const body = await c.req
    .json<{ status?: string; reply?: string }>()
    .catch(() => ({}) as { status?: string; reply?: string });
  const reply = typeof body.reply === 'string' ? body.reply.trim() : '';

  if (reply) {
    await replyToMessage(c.env, { id, reply: reply.slice(0, 5000), now: Date.now() });
    await audit(c, 'reply_message', id, existing.subject);
    if (existing.email) {
      c.executionCtx.waitUntil(
        sendContactReply(c.env, {
          to: existing.email,
          login: existing.login,
          subject: existing.subject,
          reply,
        }).then(
          () => undefined,
          (err) => console.log(`[contact] reply email failed: ${String(err)}`),
        ),
      );
    }
  } else if (body.status && isValidMessageStatus(body.status)) {
    await updateMessageStatus(c.env, id, body.status);
    await audit(c, 'update_message', id, body.status);
  } else {
    return c.json({ error: 'bad_request', message: 'Provide a reply or a valid status.' }, 400);
  }

  const updated = await getMessage(c.env, id);
  if (!updated) return c.json({ error: 'not_found' }, 404);
  return c.json({ message: updated });
});

// ── Reported repos ───────────────────────────────────────────────────────
admin.get('/reports', async (c) => {
  const statusParam = c.req.query('status');
  const status: ReportStatus | undefined = isValidReportStatus(statusParam ?? '')
    ? (statusParam as ReportStatus)
    : undefined;
  const reports = await listReports(c.env, { status, limit: 200 });
  return c.json({ reports });
});

admin.post('/reports/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await getReport(c.env, id);
  if (!existing) return c.json({ error: 'not_found' }, 404);

  const body = await c.req
    .json<{ status?: string; notes?: string }>()
    .catch(() => ({}) as { status?: string; notes?: string });
  const status =
    typeof body.status === 'string' && isValidReportStatus(body.status) ? body.status : undefined;
  const notes = typeof body.notes === 'string' ? body.notes.slice(0, 2000) : undefined;
  if (status === undefined && notes === undefined) {
    return c.json({ error: 'bad_request', message: 'Provide a status or notes.' }, 400);
  }

  await updateReport(c.env, { id, status, notes, now: Date.now() });
  await audit(c, 'update_report', existing.suspectRepo, status ?? 'notes');
  const updated = await getReport(c.env, id);
  if (!updated) return c.json({ error: 'not_found' }, 404);
  return c.json({ report: updated });
});

// ── Audit log ────────────────────────────────────────────────────────────
admin.get('/audit', async (c) => {
  const limit = Number(c.req.query('limit') ?? 100) || 100;
  const cat = c.req.query('category');
  const category = cat === 'logins' || cat === 'actions' ? cat : 'all';
  const entries = await listAudit(c.env, { limit, category });
  return c.json({ entries });
});
