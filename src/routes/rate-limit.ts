import type { Context, Next } from 'hono';

import { isAdminUser } from '../admin/policy.js';
import type { Env } from '../env.js';
import { consumeRateLimits } from '../ratelimit/store.js';
import type { RateTier } from '../ratelimit/store.js';
import type { Vars } from './middleware.js';

type AppCtx = Context<{ Bindings: Env; Variables: Vars }>;

// Per-user, per-action rate limiting. Mounted AFTER requireAuth (so the session
// and user record are present). Admins are exempt; everyone else is held to the
// supplied tiers, keyed by their login. On trip, returns 429 + Retry-After.
export function rateLimit(...tiers: RateTier[]) {
  return async function enforce(c: AppCtx, next: Next): Promise<Response | void> {
    const user = c.get('user');
    if (user && isAdminUser(user)) return next();

    const { login } = c.get('session');
    const result = await consumeRateLimits(c.env, login, tiers, Date.now());
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSec));
      return c.json(
        {
          error: 'rate_limited',
          message: 'Too many requests — please slow down and try again shortly.',
          retryAfterSec: result.retryAfterSec,
        },
        429,
      );
    }
    return next();
  };
}

// Default budgets for non-admin users. A scan fans out many GitHub calls on the
// caller's OWN token, so these guard our compute/D1 cost (and curb scripted
// abuse), not GitHub's quota. The alert tier is the tightest because it sends
// mail to a caller-supplied address (external blast radius).
export const SCAN_BURST: RateTier = { action: 'scan', limit: 20, windowMs: 60_000 };
export const SCAN_DAILY: RateTier = { action: 'scan-day', limit: 300, windowMs: 86_400_000 };
export const ALERT_EMAIL: RateTier = { action: 'alert-email', limit: 3, windowMs: 3_600_000 };
export const WRITE_BURST: RateTier = { action: 'write', limit: 12, windowMs: 60_000 };
