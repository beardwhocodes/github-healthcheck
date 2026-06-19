// Worker bindings + configuration. Secrets live in .dev.vars locally and are set
// with `wrangler secret put` in production; non-secret vars are in wrangler.jsonc.

// Minimal shape of the Cloudflare Email Sending `send_email` binding (object
// form). Defined locally because the object-form `send` signature is newer than
// the pinned @cloudflare/workers-types; at runtime the binding provides it.
export interface EmailSendBinding {
  send(message: {
    to: string | string[];
    from: { email: string; name?: string };
    replyTo?: string;
    subject: string;
    html?: string;
    text?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId?: string }>;
}

export interface Env {
  // Static assets (the built React SPA).
  ASSETS: Fetcher;
  // D1: sessions, alert subscriptions, known-clone baselines.
  DB: D1Database;
  // Cloudflare Email Sending — transactional alert + verification emails.
  EMAIL: EmailSendBinding;

  // Public config.
  APP_URL: string;
  GITHUB_CLIENT_ID: string;
  ALERT_FROM_EMAIL: string;

  // Secrets.
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
}

// Shape stored in the session row (token is encrypted at rest).
export interface SessionData {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string;
  scopes: string;
  token: string; // GitHub access token (decrypted in memory only)
}
