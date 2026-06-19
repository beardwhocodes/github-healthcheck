import { randomToken } from '../auth/crypto.js';
import type { Env } from '../env.js';
import type { MessageStatus } from '../admin/constants.js';

export interface MessageRecord {
  id: string;
  login: string;
  email: string | null;
  subject: string;
  body: string;
  status: MessageStatus;
  adminReply: string | null;
  repliedAt: number | null;
  createdAt: number;
}

interface MessageRow {
  id: string;
  login: string;
  email: string | null;
  subject: string;
  body: string;
  status: string;
  admin_reply: string | null;
  replied_at: number | null;
  created_at: number;
}

function rowToMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    login: row.login,
    email: row.email,
    subject: row.subject,
    body: row.body,
    status: (row.status as MessageStatus) ?? 'open',
    adminReply: row.admin_reply,
    repliedAt: row.replied_at,
    createdAt: row.created_at,
  };
}

export async function createMessage(
  env: Env,
  args: { login: string; email: string | null; subject: string; body: string; now: number },
): Promise<string> {
  const id = randomToken(12);
  await env.DB.prepare(
    `INSERT INTO messages (id, login, email, subject, body, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
  )
    .bind(id, args.login, args.email, args.subject, args.body, args.now)
    .run();
  return id;
}

export async function getMessage(env: Env, id: string): Promise<MessageRecord | null> {
  const row = await env.DB.prepare(`SELECT * FROM messages WHERE id = ?`).bind(id).first<MessageRow>();
  return row ? rowToMessage(row) : null;
}

export async function listMessages(
  env: Env,
  args: { status?: MessageStatus; limit: number },
): Promise<MessageRecord[]> {
  const limit = Math.max(1, Math.min(args.limit, 500));
  const stmt = args.status
    ? env.DB.prepare(
        `SELECT * FROM messages WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
      ).bind(args.status, limit)
    : env.DB.prepare(`SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`).bind(limit);
  const { results } = await stmt.all<MessageRow>();
  return (results ?? []).map(rowToMessage);
}

// A user's own submissions, so they can see admin replies in-app.
export async function listMessagesForUser(env: Env, login: string): Promise<MessageRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM messages WHERE login = ? ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(login)
    .all<MessageRow>();
  return (results ?? []).map(rowToMessage);
}

export async function countMessagesByStatus(env: Env): Promise<Record<MessageStatus, number>> {
  const { results } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS count FROM messages GROUP BY status`,
  ).all<{ status: string; count: number }>();
  const out: Record<MessageStatus, number> = { open: 0, read: 0, resolved: 0 };
  for (const r of results ?? []) {
    if (r.status === 'open' || r.status === 'read' || r.status === 'resolved') out[r.status] = r.count;
  }
  return out;
}

export async function updateMessageStatus(env: Env, id: string, status: MessageStatus): Promise<void> {
  await env.DB.prepare(`UPDATE messages SET status = ? WHERE id = ?`).bind(status, id).run();
}

// Store an admin reply (marks the thread resolved). The route separately emails
// the reply to the user if an address is on file.
export async function replyToMessage(
  env: Env,
  args: { id: string; reply: string; now: number },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE messages SET admin_reply = ?, replied_at = ?, status = 'resolved' WHERE id = ?`,
  )
    .bind(args.reply, args.now, args.id)
    .run();
}
