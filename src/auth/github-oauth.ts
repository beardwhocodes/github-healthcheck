import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import type { Env } from '../env.js';
import { randomToken, sign, verify } from './crypto.js';
import { createSession, destroySession } from './session.js';

const STATE_COOKIE = 'rs_oauth_state';

// Public-repo scan needs no special scope (read:user gives us the profile and
// 2FA status). Including private repos requires the broad `repo` scope, which we
// only request when the user explicitly opts in.
function scopesFor(includePrivate: boolean): string {
  return includePrivate ? 'read:user repo' : 'read:user';
}

export const oauth = new Hono<{ Bindings: Env }>();

oauth.get('/login', async (c) => {
  const includePrivate = c.req.query('include_private') === '1';
  const state = randomToken(16);
  const signedState = await sign(`${state}:${includePrivate ? '1' : '0'}`, c.env.SESSION_SECRET);

  setCookie(c, STATE_COOKIE, signedState, {
    httpOnly: true,
    secure: new URL(c.env.APP_URL).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: 600,
  });

  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', `${c.env.APP_URL}/auth/callback`);
  authorize.searchParams.set('scope', scopesFor(includePrivate));
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('allow_signup', 'false');

  return c.redirect(authorize.toString());
});

oauth.get('/callback', async (c) => {
  const code = c.req.query('code');
  const returnedState = c.req.query('state');
  const signedState = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: '/' });

  if (!code || !returnedState || !signedState) {
    return c.redirect('/?error=oauth_missing_params');
  }

  const verified = await verify(signedState, c.env.SESSION_SECRET);
  if (!verified) {
    return c.redirect('/?error=oauth_bad_state');
  }
  const [expectedState] = verified.split(':');
  if (expectedState !== returnedState) {
    return c.redirect('/?error=oauth_state_mismatch');
  }

  // Exchange the code for an access token.
  const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${c.env.APP_URL}/auth/callback`,
    }),
  });

  const tokenJson = (await tokenResp.json()) as {
    access_token?: string;
    scope?: string;
    error?: string;
  };
  if (!tokenJson.access_token) {
    return c.redirect(`/?error=oauth_no_token`);
  }

  // Identify the user.
  const userResp = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenJson.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'RepoSentry',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!userResp.ok) {
    return c.redirect('/?error=oauth_user_failed');
  }
  const user = (await userResp.json()) as {
    login: string;
    name: string | null;
    avatar_url: string;
  };

  await createSession(c, {
    login: user.login,
    name: user.name,
    avatarUrl: user.avatar_url,
    scopes: tokenJson.scope ?? '',
    token: tokenJson.access_token,
  });

  return c.redirect('/?signed_in=1');
});

oauth.post('/logout', async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});
