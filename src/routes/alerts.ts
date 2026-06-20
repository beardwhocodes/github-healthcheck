import { Hono } from 'hono';

import { encrypt, randomToken } from '../auth/crypto.js';
import { findClonesForRepos } from '../github/clone-detection.js';
import type { Env } from '../env.js';
import {
  deactivateSubscription,
  getSubscription,
  recordClones,
  setWatchedRepos,
  upsertSubscription,
} from '../alerts/store.js';
import { sendVerificationEmail } from '../alerts/email.js';
import { requireNotSuspended } from './middleware.js';
import type { Vars } from './middleware.js';
import { ALERT_EMAIL, rateLimit } from './rate-limit.js';

export const alerts = new Hono<{ Bindings: Env; Variables: Vars }>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

alerts.get('/alerts', async (c) => {
  const session = c.get('session');
  const sub = await getSubscription(c.env, session.login);
  const active = sub?.active === 1;
  return c.json({
    subscribed: active && sub?.verified === 1,
    pending: active && sub?.verified === 0,
    email: active ? (sub?.email ?? null) : null,
    lastRunAt: sub?.lastRunAt ?? null,
  });
});

// Subscribe to future-impersonation alerts. Creates an UNVERIFIED subscription
// and emails a confirmation link (double opt-in) — no alert is ever sent until
// the address is verified. We also snapshot the user's current clones as a
// baseline so the first alert only fires on NEW clones that appear later.
//
// Suspension-gated: this is the heaviest path (GitHub *search* + outbound email)
// and enrolls the daily cron, so a suspended account must not reach it. GET/DELETE
// stay open so a suspended user can still view or cancel an existing subscription.
alerts.post('/alerts', requireNotSuspended, rateLimit(ALERT_EMAIL), async (c) => {
  const session = c.get('session');
  const client = c.get('client');
  const now = Date.now();

  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
  const email = (body.email ?? '').trim();
  if (!EMAIL_RE.test(email)) {
    return c.json({ error: 'bad_email', message: 'Enter a valid email address.' }, 400);
  }

  try {
    const tokenEnc = await encrypt(session.token, c.env.SESSION_SECRET);
    const verifyToken = randomToken(32);
    const unsubscribeToken = randomToken(32);
    await upsertSubscription(c.env, {
      login: session.login,
      email,
      tokenEnc,
      verifyToken,
      unsubscribeToken,
      now,
    });

    const rawRepos = await client.listRepos({ login: session.login, self: true });
    const sources = rawRepos
      .filter((r) => !r.fork && !r.private)
      .map((r) => ({
        owner: String((r.owner as Record<string, unknown>)?.login ?? session.login),
        fullName: String(r.full_name ?? ''),
        description: (r.description as string | null) ?? null,
        stargazers: Number(r.stargazers_count ?? 0),
      }))
      .sort((a, b) => b.stargazers - a.stargazers)
      .slice(0, 15);

    await setWatchedRepos(c.env, session.login, sources.map((s) => s.fullName));

    // Seed baseline (record current clones as already-notified).
    const existing = await findClonesForRepos(client, sources, { now });
    await recordClones(
      c.env,
      session.login,
      existing.map((m) => ({
        sourceRepo: m.sourceRepo,
        suspectRepo: m.suspectRepo,
        confidence: m.confidence,
        firstSeen: now,
        notified: true,
      })),
    );

    const { sent } = await sendVerificationEmail(c.env, {
      to: email,
      login: session.login,
      verifyToken,
      unsubscribeToken,
    });

    return c.json({ subscribed: false, pending: true, email, lastRunAt: null, verificationSent: sent });
  } catch {
    return c.json({ error: 'subscribe_failed', message: 'Could not set up alerts.' }, 500);
  }
});

alerts.delete('/alerts', async (c) => {
  const session = c.get('session');
  await deactivateSubscription(c.env, session.login);
  return c.json({ subscribed: false, pending: false, email: null, lastRunAt: null });
});
