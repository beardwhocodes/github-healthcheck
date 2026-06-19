import type { Env } from '../env.js';

export interface Subscription {
  login: string;
  email: string;
  tokenEnc: string;
  active: number;
  verified: number;
  verifyToken: string | null;
  unsubscribeToken: string | null;
  verifiedAt: number | null;
  createdAt: number;
  lastRunAt: number | null;
}

interface SubscriptionRow {
  login: string;
  email: string;
  token_enc: string;
  active: number;
  verified: number;
  verify_token: string | null;
  unsubscribe_token: string | null;
  verified_at: number | null;
  created_at: number;
  last_run_at: number | null;
}

function rowToSubscription(row: SubscriptionRow): Subscription {
  return {
    login: row.login,
    email: row.email,
    tokenEnc: row.token_enc,
    active: row.active,
    verified: row.verified,
    verifyToken: row.verify_token,
    unsubscribeToken: row.unsubscribe_token,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at,
  };
}

// Create or replace a subscription. Always starts UNVERIFIED with fresh tokens —
// (re)subscribing requires a new email confirmation before any alert is sent.
export async function upsertSubscription(
  env: Env,
  args: {
    login: string;
    email: string;
    tokenEnc: string;
    verifyToken: string;
    unsubscribeToken: string;
    now: number;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO alert_subscriptions
       (login, email, token_enc, active, verified, verify_token, unsubscribe_token, verified_at, created_at)
     VALUES (?, ?, ?, 1, 0, ?, ?, NULL, ?)
     ON CONFLICT(login) DO UPDATE SET
       email = excluded.email,
       token_enc = excluded.token_enc,
       active = 1,
       verified = 0,
       verify_token = excluded.verify_token,
       unsubscribe_token = excluded.unsubscribe_token,
       verified_at = NULL,
       last_run_at = NULL`,
  )
    .bind(args.login, args.email, args.tokenEnc, args.verifyToken, args.unsubscribeToken, args.now)
    .run();
}

export async function getSubscription(env: Env, login: string): Promise<Subscription | null> {
  const row = await env.DB.prepare(`SELECT * FROM alert_subscriptions WHERE login = ?`)
    .bind(login)
    .first<SubscriptionRow>();
  return row ? rowToSubscription(row) : null;
}

// Confirm an email via its verification token. Returns the now-verified
// subscription, or null if the token is unknown/already used.
export async function verifyByToken(
  env: Env,
  token: string,
  now: number,
): Promise<Subscription | null> {
  if (!token) return null;
  const row = await env.DB.prepare(`SELECT * FROM alert_subscriptions WHERE verify_token = ?`)
    .bind(token)
    .first<SubscriptionRow>();
  if (!row) return null;

  await env.DB.prepare(
    `UPDATE alert_subscriptions
       SET verified = 1, verified_at = ?, verify_token = NULL
     WHERE login = ?`,
  )
    .bind(now, row.login)
    .run();

  return rowToSubscription({ ...row, verified: 1, verified_at: now, verify_token: null });
}

// Unsubscribe: deactivate AND erase the stored GitHub token (we no longer need
// it, and a dormant encrypted token is needless exposure). Watched repos and the
// clone baseline are cleared too so nothing keeps running for this user.
export async function deactivateSubscription(env: Env, login: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE alert_subscriptions
         SET active = 0, token_enc = '', verify_token = NULL, unsubscribe_token = NULL
       WHERE login = ?`,
    ).bind(login),
    env.DB.prepare(`DELETE FROM watched_repos WHERE login = ?`).bind(login),
    env.DB.prepare(`DELETE FROM known_clones WHERE login = ?`).bind(login),
  ]);
}

// No-login unsubscribe via the token embedded in emails. Returns the login that
// was unsubscribed, or null if the token is unknown.
export async function deactivateByUnsubscribeToken(
  env: Env,
  token: string,
): Promise<string | null> {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT login FROM alert_subscriptions WHERE unsubscribe_token = ?`,
  )
    .bind(token)
    .first<{ login: string }>();
  if (!row) return null;
  await deactivateSubscription(env, row.login);
  return row.login;
}

// Only verified, active, NON-suspended subscriptions are ever scanned/emailed by
// the cron. The LEFT JOIN excludes anyone the admin has suspended (a missing
// users row — e.g. legacy data — is treated as not suspended).
export async function listActiveSubscriptions(env: Env): Promise<Subscription[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.*
       FROM alert_subscriptions s
       LEFT JOIN users u ON u.login = s.login
      WHERE s.active = 1 AND s.verified = 1 AND u.suspended_at IS NULL`,
  ).all<SubscriptionRow>();
  return (results ?? []).map(rowToSubscription);
}

export async function setWatchedRepos(env: Env, login: string, fullNames: string[]): Promise<void> {
  await env.DB.prepare(`DELETE FROM watched_repos WHERE login = ?`).bind(login).run();
  if (fullNames.length === 0) return;
  const stmts = fullNames.map((fullName) =>
    env.DB.prepare(`INSERT OR IGNORE INTO watched_repos (login, full_name) VALUES (?, ?)`).bind(
      login,
      fullName,
    ),
  );
  await env.DB.batch(stmts);
}

export async function getWatchedRepos(env: Env, login: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT full_name FROM watched_repos WHERE login = ?`,
  )
    .bind(login)
    .all<{ full_name: string }>();
  return (results ?? []).map((r) => r.full_name);
}

export async function getKnownSuspectRepos(env: Env, login: string): Promise<Set<string>> {
  const { results } = await env.DB.prepare(
    `SELECT suspect_repo FROM known_clones WHERE login = ?`,
  )
    .bind(login)
    .all<{ suspect_repo: string }>();
  return new Set((results ?? []).map((r) => r.suspect_repo.toLowerCase()));
}

export async function recordClones(
  env: Env,
  login: string,
  clones: { sourceRepo: string; suspectRepo: string; confidence: number; notified: boolean; firstSeen: number }[],
): Promise<void> {
  if (clones.length === 0) return;
  const stmts = clones.map((clone) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO known_clones (login, source_repo, suspect_repo, confidence, first_seen, notified)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      login,
      clone.sourceRepo,
      clone.suspectRepo,
      clone.confidence,
      clone.firstSeen,
      clone.notified ? 1 : 0,
    ),
  );
  await env.DB.batch(stmts);
}

export async function setLastRun(env: Env, login: string, now: number): Promise<void> {
  await env.DB.prepare(`UPDATE alert_subscriptions SET last_run_at = ? WHERE login = ?`)
    .bind(now, login)
    .run();
}
