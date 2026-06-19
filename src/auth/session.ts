import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import type { Env, SessionData } from '../env.js';
import { decrypt, encrypt, randomToken } from './crypto.js';

const COOKIE = 'rs_session';
const SESSION_TTL_DAYS = 14;

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
  const tokenEnc = await encrypt(user.token, c.env.SESSION_SECRET);
  const expiresAt = Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

  await c.env.DB.prepare(
    `INSERT INTO sessions (id, login, name, avatar_url, scopes, token_enc, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, user.login, user.name, user.avatarUrl, user.scopes, tokenEnc, expiresAt)
    .run();

  setCookie(c, COOKIE, id, {
    httpOnly: true,
    secure: new URL(c.env.APP_URL).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

export async function getSession<E extends AppEnv>(c: Context<E>): Promise<SessionData | null> {
  const id = getCookie(c, COOKIE);
  if (!id) return null;

  const row = await c.env.DB.prepare(`SELECT * FROM sessions WHERE id = ?`)
    .bind(id)
    .first<SessionRow>();
  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run();
    return null;
  }

  let token: string;
  try {
    token = await decrypt(row.token_enc, c.env.SESSION_SECRET);
  } catch {
    return null;
  }

  return {
    id: row.id,
    login: row.login,
    name: row.name,
    avatarUrl: row.avatar_url,
    scopes: row.scopes,
    token,
  };
}

export async function destroySession<E extends AppEnv>(c: Context<E>): Promise<void> {
  const id = getCookie(c, COOKIE);
  if (id) {
    await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run();
  }
  deleteCookie(c, COOKIE, { path: '/' });
}
