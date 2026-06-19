import type { Context, Next } from 'hono';

import type { Env, SessionData } from '../env.js';
import { GitHubClient } from '../github/client.js';
import { getSession } from '../auth/session.js';

export interface Vars {
  session: SessionData;
  client: GitHubClient;
}

// Gate /api/* behind a valid session and attach an authenticated GitHub client.
export async function requireAuth(
  c: Context<{ Bindings: Env; Variables: Vars }>,
  next: Next,
): Promise<Response | void> {
  const session = await getSession(c);
  if (!session) {
    return c.json({ error: 'unauthorized', message: 'Sign in with GitHub first.' }, 401);
  }
  c.set('session', session);
  c.set('client', new GitHubClient(session.token));
  await next();
}
