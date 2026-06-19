import { Hono } from 'hono';

import { runImpersonationScan } from './alerts/cron.js';
import { oauth } from './auth/github-oauth.js';
import type { Env } from './env.js';
import { alerts } from './routes/alerts.js';
import { requireAuth } from './routes/middleware.js';
import type { Vars } from './routes/middleware.js';
import { scan } from './routes/scan.js';

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// Baseline security headers for every response.
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'DENY');
});

// OAuth (login / callback / logout).
app.route('/auth', oauth);

// Authenticated JSON API.
const api = new Hono<{ Bindings: Env; Variables: Vars }>();
api.use('*', requireAuth);
api.route('/', scan);
api.route('/', alerts);
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
    ctx.waitUntil(runImpersonationScan(env, Date.now()));
  },
};
