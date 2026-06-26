import { Hono } from 'hono';
import { csrf } from 'hono/csrf';

import { runImpersonationScan } from './alerts/cron.js';
import { oauth } from './auth/github-oauth.js';
import { sweepExpiredSessions } from './auth/session.js';
import { pruneRateEvents } from './ratelimit/store.js';
import type { Env } from './env.js';
import { admin } from './routes/admin.js';
import { alerts } from './routes/alerts.js';
import { contact } from './routes/contact.js';
import { email } from './routes/email.js';
import { requireAuth } from './routes/middleware.js';
import type { Vars } from './routes/middleware.js';
import { scan } from './routes/scan.js';

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// Content-Security-Policy for worker-served responses. `script-src 'self'` (no
// 'unsafe-inline') neutralizes any javascript:/inline-script vector; the /email
// confirmation pages use inline STYLE attributes only, hence style 'unsafe-inline'.
// Static SPA assets are served by the Assets binding (not this Worker), so they
// carry the equivalent policy from web/public/_headers.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https://avatars.githubusercontent.com https://*.githubusercontent.com data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

// Baseline security headers for every worker response.
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'DENY');
  c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  c.header('Content-Security-Policy', CSP);
});

// OAuth (login / callback / logout).
app.route('/auth', oauth);

// Public, token-secured email links (verify / unsubscribe) — no auth.
app.route('/email', email);

// Authenticated JSON API.
const api = new Hono<{ Bindings: Env; Variables: Vars }>();
api.use('*', csrf());          // same-origin check on unsafe methods
// Additional Origin check for JSON mutation requests (hono/csrf guards form
// submissions; this gate covers application/json API calls on the same group).
api.use('*', async (c, next) => {
  const safeMethods = /^(GET|HEAD|OPTIONS|TRACE)$/;
  if (!safeMethods.test(c.req.method)) {
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== new URL(c.req.url).origin) {
      return c.json({ error: 'forbidden', message: 'Cross-origin request rejected.' }, 403);
    }
  }
  await next();
});
api.use('*', requireAuth);
api.route('/', scan);
api.route('/', alerts);
api.route('/', contact);
// Admin surface (requireAdmin is applied inside the admin router).
api.route('/admin', admin);
app.route('/api', api);

app.notFound((c) => {
  // API namespace returns JSON 404s; everything else falls through to the SPA.
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = Date.now();
    ctx.waitUntil(runImpersonationScan(env, now));
    // Daily maintenance: purge expired sessions and old rate-limit events.
    ctx.waitUntil(sweepExpiredSessions(env, now));
    ctx.waitUntil(pruneRateEvents(env, now - 24 * 60 * 60 * 1000));
  },
};
