import type { Env } from '../env.js';

export interface Subscription {
  login: string;
  email: string;
  tokenEnc: string;
  active: number;
  createdAt: number;
  lastRunAt: number | null;
}

export async function upsertSubscription(
  env: Env,
  args: { login: string; email: string; tokenEnc: string; now: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO alert_subscriptions (login, email, token_enc, active, created_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(login) DO UPDATE SET email = excluded.email, token_enc = excluded.token_enc, active = 1`,
  )
    .bind(args.login, args.email, args.tokenEnc, args.now)
    .run();
}

export async function getSubscription(env: Env, login: string): Promise<Subscription | null> {
  const row = await env.DB.prepare(`SELECT * FROM alert_subscriptions WHERE login = ?`)
    .bind(login)
    .first<{
      login: string;
      email: string;
      token_enc: string;
      active: number;
      created_at: number;
      last_run_at: number | null;
    }>();
  if (!row) return null;
  return {
    login: row.login,
    email: row.email,
    tokenEnc: row.token_enc,
    active: row.active,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at,
  };
}

export async function deactivateSubscription(env: Env, login: string): Promise<void> {
  await env.DB.prepare(`UPDATE alert_subscriptions SET active = 0 WHERE login = ?`)
    .bind(login)
    .run();
}

export async function listActiveSubscriptions(env: Env): Promise<Subscription[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM alert_subscriptions WHERE active = 1`,
  ).all<{
    login: string;
    email: string;
    token_enc: string;
    active: number;
    created_at: number;
    last_run_at: number | null;
  }>();
  return (results ?? []).map((row) => ({
    login: row.login,
    email: row.email,
    tokenEnc: row.token_enc,
    active: row.active,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at,
  }));
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
