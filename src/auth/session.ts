import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import type { Env, SessionData } from '../env.js';
import { decrypt, encrypt, randomToken, sha256Hex } from './crypto.js';

const COOKIE = 'rs_session';
const SESSION_TTL_DAYS = 14;

// In production (https) we pin the session cookie with the __Host- prefix, which
// browsers honor only with Secure + Path=/ + no Domain — locking it to this exact
// origin. Local http dev can't use it, so we fall back to the bare name. The READ
// path must mirror this, so every getCookie/deleteCookie derives the prefix the
// same way it was set.
function cookiePrefix(env: Env): 'host' | undefined {
  return new URL(env.APP_URL).protocol === 'https:' ? 'host' : undefined;
}

interface SessionRow {
  id: string;
  login: string;
  name: string | null;
  avatar_url: string;
  scopes: string;
  token_enc: string;
  expires_at: number;
}

// Generic over the Hono env so callers carrying route-specific Variables (which
// Hono's invariant Context generic would otherwise reject) are still accepted,
// as long as their Bindings include our Env.
type AppEnv = { Bindings: Env };

// Create a server-side session: the GitHub token is encrypted at rest, and only
// an opaque, high-entropy id is placed in the cookie.
export async function createSession<E extends AppEnv>(
  c: Context<E>,
  user: { login: string; name: string | null; avatarUrl: string; scopes: string; token: string },
): Promise<void> {
  const id = randomToken(32);
  const idHash = await sha256Hex(id);
  const tokenEnc = await encrypt(user.token, c.env.SESSION_SECRET);
  const expiresAt = Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

  // Store only the hash of the id; the raw id lives solely in the cookie. A D1
  // read therefore yields no replayable session credential.
  await c.env.DB.prepare(
    `INSERT INTO sessions (id, login, name, avatar_url, scopes, token_enc, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(idHash, user.login, user.name, user.avatarUrl, user.scopes, tokenEnc, expiresAt)
    .run();

  const prefix = cookiePrefix(c.env);
  setCookie(c, COOKIE, id, {
    httpOnly: true,
    secure: prefix === 'host',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    prefix,
  });
}

export async function getSession<E extends AppEnv>(c: Context<E>): Promise<SessionData | null> {
  const id = getCookie(c, COOKIE, cookiePrefix(c.env));
  if (!id) return null;
  const idHash = await sha256Hex(id);

  const row = await c.env.DB.prepare(`SELECT * FROM sessions WHERE id = ?`)
    .bind(idHash)
    .first<SessionRow>();
  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(idHash).run();
    return null;
  }

  // decrypt returns null for an unknown ciphertext version (scheme change) and
  // throws for a malformed/auth-failed current-version blob; both mean the stored
  // token is unusable, so the session is treated as invalid (re-auth needed).
  let token: string | null;
  try {
    token = await decrypt(row.token_enc, c.env.SESSION_SECRET);
  } catch {
    token = null;
  }
  if (token === null) return null;

  return {
    id: row.id,
    login: row.login,
    name: row.name,
    avatarUrl: row.avatar_url,
    scopes: row.scopes,
    token,
  };
}

// Bulk-delete sessions whose TTL has passed. Called from the daily cron so the
// encrypted-token rows of abandoned sessions don't linger past their expiry
// (getSession only deletes the one id it looks up).
export async function sweepExpiredSessions(env: Env, now: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now).run();
}

// Delete EVERY session row for a login (not just the current cookie's), for full
// account erasure (DELETE /api/me). Returns the statement so it runs atomically
// in the account-deletion batch; the caller still clears the cookie separately.
export function deleteSessionsStatement(env: Env, login: string): D1PreparedStatement {
  return env.DB.prepare(`DELETE FROM sessions WHERE login = ?`).bind(login);
}

export async function destroySession<E extends AppEnv>(c: Context<E>): Promise<void> {
  const prefix = cookiePrefix(c.env);
  const id = getCookie(c, COOKIE, prefix);
  if (id) {
    const idHash = await sha256Hex(id);
    await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(idHash).run();
  }
  deleteCookie(c, COOKIE, { path: '/', prefix });
}
