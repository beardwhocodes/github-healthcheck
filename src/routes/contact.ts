import { Hono } from 'hono';

import type { Env } from '../env.js';
import { validateContact } from '../admin/policy.js';
import { ABUSE_CATEGORIES } from '../admin/constants.js';
import type { AbuseCategory } from '../admin/constants.js';
import { createMessage, listMessagesForUser } from '../messages/store.js';
import { recordReport } from '../reports/store.js';
import { sendAdminContactNotice } from '../alerts/email.js';
import type { Vars } from './middleware.js';

export const contact = new Hono<{ Bindings: Env; Variables: Vars }>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Submit a support question/issue. Any signed-in user. The email (optional) lets
// an admin reply by mail; it is validated but not required.
contact.post('/contact', async (c) => {
  const session = c.get('session');
  const now = Date.now();
  const raw = await c.req
    .json<{ subject?: unknown; body?: unknown; email?: unknown }>()
    .catch(() => ({}) as { subject?: unknown; body?: unknown; email?: unknown });

  const valid = validateContact({ subject: raw.subject, body: raw.body });
  if (!valid.ok) return c.json({ error: 'bad_request', message: valid.error }, 400);

  const emailInput = typeof raw.email === 'string' ? raw.email.trim() : '';
  const email = emailInput && EMAIL_RE.test(emailInput) ? emailInput : null;

  const id = await createMessage(c.env, {
    login: session.login,
    email,
    subject: valid.value.subject,
    body: valid.value.body,
    now,
  });

  // Best-effort admin notification (no-op unless ADMIN_EMAIL is set).
  c.executionCtx.waitUntil(
    sendAdminContactNotice(c.env, {
      from: session.login,
      subject: valid.value.subject,
      body: valid.value.body,
    }).then(
      () => undefined,
      (err) => console.log(`[contact] admin notice failed: ${String(err)}`),
    ),
  );

  return c.json({ ok: true, id });
});

// The caller's own past messages + any admin replies (in-app two-way support).
contact.get('/contact', async (c) => {
  const session = c.get('session');
  const messages = await listMessagesForUser(c.env, session.login);
  return c.json({ messages });
});

// Log that the user reported a suspect repo to GitHub, building an audit trail an
// admin can triage. Called by the clone panel when "Report to GitHub" is clicked.
contact.post('/reports', async (c) => {
  const session = c.get('session');
  const now = Date.now();
  type ReportBody = {
    suspectRepo?: unknown;
    suspectUrl?: unknown;
    sourceRepo?: unknown;
    confidence?: unknown;
    category?: unknown;
  };
  const raw = await c.req.json<ReportBody>().catch(() => ({}) as ReportBody);

  const suspectRepo = typeof raw.suspectRepo === 'string' ? raw.suspectRepo.trim() : '';
  if (!suspectRepo) return c.json({ error: 'bad_request', message: 'suspectRepo is required.' }, 400);

  const category: AbuseCategory | null =
    typeof raw.category === 'string' && (ABUSE_CATEGORIES as readonly string[]).includes(raw.category)
      ? (raw.category as AbuseCategory)
      : null;

  await recordReport(c.env, {
    reporterLogin: session.login,
    suspectRepo: suspectRepo.slice(0, 200),
    suspectUrl: typeof raw.suspectUrl === 'string' ? raw.suspectUrl.slice(0, 400) : null,
    sourceRepo: typeof raw.sourceRepo === 'string' ? raw.sourceRepo.slice(0, 200) : null,
    confidence: typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
      ? Math.max(0, Math.min(100, Math.round(raw.confidence)))
      : null,
    category,
    now,
  });

  return c.json({ ok: true });
});
