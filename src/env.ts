// Worker bindings + configuration. Secrets live in .dev.vars locally and are set
// with `wrangler secret put` in production; non-secret vars are in wrangler.jsonc.
export interface Env {
  // Static assets (the built React SPA).
  ASSETS: Fetcher;
  // D1: sessions, alert subscriptions, known-clone baselines.
  DB: D1Database;

  // Public config.
  APP_URL: string;
  GITHUB_CLIENT_ID: string;
  ALERT_FROM_EMAIL: string;

  // Secrets.
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  RESEND_API_KEY?: string;
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
