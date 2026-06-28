import { randomToken } from '../auth/crypto.js';
import type { Env } from '../env.js';

// Verify/unsubscribe tokens are stored as a SHA-256 hash, never plaintext: a DB
// read can't reconstruct a working capability link, and the raw token lives only
// in the emailed URL. Hashing is implemented locally (Web Crypto) on purpose —
// the auth/session crypto module is owned elsewhere and we don't depend on it.
const tokenEncoder = new TextEncoder();

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', tokenEncoder.encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// How long an email-confirmation (verify) token stays valid. The /email/verify
// page already tells users a stale link "expired"; this makes that copy truthful.
const VERIFY_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
  // Cursor for cron sharding (least-recently-scanned first); NULL = never scanned.
  lastScannedAt: number | null;
  // Epoch ms after which a verify token is rejected; NULL = legacy/non-expiring.
  verifyExpiresAt: number | null;
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
  last_scanned_at: number | null;
  verify_expires_at: number | null;
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
    lastScannedAt: row.last_scanned_at,
    verifyExpiresAt: row.verify_expires_at,
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
  // Store only the token HASHES; the raw tokens go into the emailed URLs.
  const verifyHash = await hashToken(args.verifyToken);
  const unsubscribeHash = await hashToken(args.unsubscribeToken);
  const verifyExpiresAt = args.now + VERIFY_TOKEN_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO alert_subscriptions
       (login, email, token_enc, active, verified, verify_token, unsubscribe_token, verified_at, created_at, verify_expires_at)
     VALUES (?, ?, ?, 1, 0, ?, ?, NULL, ?, ?)
     ON CONFLICT(login) DO UPDATE SET
       email = excluded.email,
       token_enc = excluded.token_enc,
       active = 1,
       verified = 0,
       verify_token = excluded.verify_token,
       unsubscribe_token = excluded.unsubscribe_token,
       verified_at = NULL,
       last_run_at = NULL,
       last_scanned_at = NULL,
       verify_expires_at = excluded.verify_expires_at`,
  )
    .bind(
      args.login,
      args.email,
      args.tokenEnc,
      verifyHash,
      unsubscribeHash,
      args.now,
      verifyExpiresAt,
    )
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
    .bind(await hashToken(token))
    .first<SubscriptionRow>();
  if (!row) return null;

  // Reject expired links so the "Link expired" copy is truthful. NULL expiry is
  // a legacy row predating this column — treat it as non-expiring.
  if (row.verify_expires_at !== null && now > row.verify_expires_at) return null;

  await env.DB.prepare(
    `UPDATE alert_subscriptions
       SET verified = 1, verified_at = ?, verify_token = NULL, verify_expires_at = NULL
     WHERE login = ?`,
  )
    .bind(now, row.login)
    .run();

  return rowToSubscription({
    ...row,
    verified: 1,
    verified_at: now,
    verify_token: null,
    verify_expires_at: null,
  });
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

// Full erasure of a subscriber's alert footprint: the subscription row (incl.
// its encrypted GitHub token), watched repos, and the clone baseline. Used by
// account deletion (DELETE /api/me). deactivateSubscription only soft-disables
// and zeroes the token; this removes the rows entirely. Returns the statements
// so the caller runs them atomically with the rest of the account's deletion.
export function deleteAlertDataStatements(env: Env, login: string): D1PreparedStatement[] {
  return [
    env.DB.prepare(`DELETE FROM alert_subscriptions WHERE login = ?`).bind(login),
    env.DB.prepare(`DELETE FROM watched_repos WHERE login = ?`).bind(login),
    env.DB.prepare(`DELETE FROM known_clones WHERE login = ?`).bind(login),
  ];
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
    .bind(await hashToken(token))
    .first<{ login: string }>();
  if (!row) return null;
  await deactivateSubscription(env, row.login);
  return row.login;
}

// Only verified, active, NON-suspended subscriptions are ever scanned/emailed by
// the cron. The LEFT JOIN excludes anyone the admin has suspended (a missing
// users row — e.g. legacy data — is treated as not suspended).
//
// `limit` shards the daily cron: it fetches a bounded batch ordered by
// least-recently-scanned (last_scanned_at ASC puts NULL — never scanned — first
// in SQLite), so one invocation can't fan out over every subscriber and exhaust
// the Workers subrequest budget. Omit `limit` for the full set (admin/tests).
export async function listActiveSubscriptions(
  env: Env,
  limit?: number,
): Promise<Subscription[]> {
  // Bind order mirrors the SQL: no subquery/WHERE binds, then LIMIT last.
  const base = `SELECT s.*
       FROM alert_subscriptions s
       LEFT JOIN users u ON u.login = s.login
      WHERE s.active = 1 AND s.verified = 1 AND u.suspended_at IS NULL`;
  const stmt =
    limit !== undefined
      ? env.DB.prepare(`${base} ORDER BY s.last_scanned_at ASC LIMIT ?`).bind(limit)
      : env.DB.prepare(base);
  const { results } = await stmt.all<SubscriptionRow>();
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
    `SELECT suspect_repo FROM known_clones WHERE login = ? AND notified = 1`,
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
      `INSERT INTO known_clones (login, source_repo, suspect_repo, confidence, first_seen, notified)
         VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(login, suspect_repo) DO UPDATE SET
         notified = CASE WHEN excluded.notified = 1 THEN 1 ELSE known_clones.notified END`,
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

// last_run_at marks a CLEAN scan ("scanned, none found" or alerts sent). The
// cron advances it only on clean completion, never on an aborted scan.
export async function setLastRun(env: Env, login: string, now: number): Promise<void> {
  await env.DB.prepare(`UPDATE alert_subscriptions SET last_run_at = ? WHERE login = ?`)
    .bind(now, login)
    .run();
}

// The cron emails impersonation alerts long after subscribe time, when only the
// stored HASH of the unsubscribe token survives. Mint a fresh raw token, persist
// its hash, and return the raw token for the email's unsubscribe URL. Older
// emails' links stop working — acceptable; the newest alert always carries a
// valid one (required for RFC 8058 one-click unsubscribe).
export async function rotateUnsubscribeToken(env: Env, login: string): Promise<string> {
  const raw = randomToken(32);
  await env.DB.prepare(`UPDATE alert_subscriptions SET unsubscribe_token = ? WHERE login = ?`)
    .bind(await hashToken(raw), login)
    .run();
  return raw;
}

// last_scanned_at is the sharding cursor. The cron advances it whenever a sub is
// ATTEMPTED (clean or aborted) so the batch rotates and one stuck sub can't
// starve the rest; an abort is surfaced by last_run_at staying stale, not here.
export async function setLastScanned(env: Env, login: string, now: number): Promise<void> {
  await env.DB.prepare(`UPDATE alert_subscriptions SET last_scanned_at = ? WHERE login = ?`)
    .bind(now, login)
    .run();
}
