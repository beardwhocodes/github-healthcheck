import type { Context, Next } from 'hono';

import type { Env, SessionData, UserRecord } from '../env.js';
import { GitHubClient } from '../github/client.js';
import { getSession } from '../auth/session.js';
import { isAdminUser } from '../admin/policy.js';
import { ensureUser } from '../users/store.js';

export interface Vars {
  session: SessionData;
  client: GitHubClient;
  user: UserRecord;
}

type AppCtx = Context<{ Bindings: Env; Variables: Vars }>;

// Gate /api/* behind a valid session, attach an authenticated GitHub client, and
// resolve the durable user record (creating it for sessions that predate the
// users table). Downstream gates (admin, suspension) read c.get('user').
export async function requireAuth(c: AppCtx, next: Next): Promise<Response | void> {
  const session = await getSession(c);
  if (!session) {
    return c.json({ error: 'unauthorized', message: 'Sign in with GitHub first.' }, 401);
  }
  const user = await ensureUser(c.env, {
    login: session.login,
    name: session.name,
    avatarUrl: session.avatarUrl,
    includesPrivate: session.scopes.split(/[ ,]+/).includes('repo'),
    now: Date.now(),
  });
  c.set('session', session);
  c.set('client', new GitHubClient(session.token));
  c.set('user', user);
  await next();
}

// Admin-only gate. Assumes requireAuth has already run (it is mounted under the
// authenticated /api group), so c.get('user') is present. Returns 404 — not 403
// — so the admin surface is not even acknowledged to non-admins.
export async function requireAdmin(c: AppCtx, next: Next): Promise<Response | void> {
  const user = c.get('user');
  if (!user || !isAdminUser(user)) {
    return c.json({ error: 'not_found' }, 404);
  }
  await next();
}

// Block scan actions for suspended users (but not /me, so the SPA can show the
// suspended notice and let them reach support).
export async function requireNotSuspended(c: AppCtx, next: Next): Promise<Response | void> {
  const user = c.get('user');
  if (user?.suspendedAt) {
    return c.json(
      {
        error: 'suspended',
        message: 'Your account is suspended.',
        reason: user.suspendedReason ?? null,
      },
      403,
    );
  }
  await next();
}
