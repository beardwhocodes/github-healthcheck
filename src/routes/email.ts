import { Hono } from 'hono';
import type { Context } from 'hono';

import type { Env } from '../env.js';
import { deactivateByUnsubscribeToken, verifyByToken } from '../alerts/store.js';

// Public, no-auth routes hit from links inside emails. Authorization is the
// unguessable token in the query string.
export const email = new Hono<{ Bindings: Env }>();

email.get('/verify', async (c) => {
  const token = c.req.query('token') ?? '';
  const sub = await verifyByToken(c.env, token, Date.now());
  if (!sub) {
    return c.html(
      page('Link expired', 'This confirmation link is invalid or has already been used. Re-subscribe from the app to get a fresh one.', c.env.APP_URL),
      400,
    );
  }
  return c.html(
    page(
      'Email confirmed ✓',
      `Alerts are now active for <strong>${escapeHtml(sub.email)}</strong>. We'll email you when a new malicious clone of your repositories appears.`,
      c.env.APP_URL,
    ),
  );
});

async function handleUnsubscribe(c: Context<{ Bindings: Env }>): Promise<Response> {
  const token = c.req.query('token') ?? '';
  const login = await deactivateByUnsubscribeToken(c.env, token);
  if (!login) {
    return c.html(
      page('Already unsubscribed', 'This link is invalid or you have already unsubscribed.', c.env.APP_URL),
    );
  }
  return c.html(
    page(
      'Unsubscribed',
      "You won't receive any more impersonation alerts. You can re-enable them anytime from the app.",
      c.env.APP_URL,
    ),
  );
}

email.get('/unsubscribe', handleUnsubscribe);
// RFC 8058 one-click unsubscribe (mail clients POST to the List-Unsubscribe URL).
email.post('/unsubscribe', handleUnsubscribe);

// `title` and `appUrl` are escaped here, but `body` is interpolated as RAW HTML
// so callers can include intentional markup (e.g. <strong>). CONTRACT: any
// dynamic/user-derived value placed in `body` MUST be escaped by the caller
// (see the escapeHtml(sub.email) call above). Do not pass unescaped input here.
function page(title: string, body: string, appUrl: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)} — GitHub Healthcheck</title></head>
  <body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1020;
    font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e6ebf5">
    <div style="max-width:440px;margin:24px;padding:28px;background:#151d36;border:1px solid #243049;border-radius:14px;text-align:center">
      <div style="font-size:28px">🛡️</div>
      <h1 style="font-size:20px;margin:10px 0 8px">${escapeHtml(title)}</h1>
      <p style="color:#9aa6c0;font-size:15px;line-height:1.5;margin:0 0 18px">${body}</p>
      <a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#4f8cff;color:#fff;padding:10px 16px;
        border-radius:9px;text-decoration:none;font-weight:600">Open GitHub Healthcheck</a>
    </div>
  </body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}
