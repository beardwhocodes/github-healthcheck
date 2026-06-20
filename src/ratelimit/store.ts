import type { Env } from '../env.js';

// A single sliding-window tier: at most `limit` accepted requests per `windowMs`
// for a given action. `action` namespaces the bucket so different actions have
// independent budgets.
export interface RateTier {
  action: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

// Enforce every tier for one login against the D1 `rate_events` table. Counts the
// events inside each tier's window; if ANY tier is at its limit, the request is
// denied and NOTHING is recorded (a rejected request doesn't consume budget).
// Otherwise one event per tier is recorded in a single batch.
//
// Atomicity is best-effort: a burst of concurrent requests can read the same
// pre-insert count and overshoot by ~concurrency. The durable inserts make
// sustained/sequential abuse hard-capped at `limit` per window, which is what
// bounds cost (the expensive work here all runs on the caller's own GitHub
// quota, so a small burst overshoot is acceptable).
export async function consumeRateLimits(
  env: Env,
  login: string,
  tiers: readonly RateTier[],
  now: number,
): Promise<RateLimitResult> {
  for (const tier of tiers) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MIN(created_at) AS oldest
         FROM rate_events WHERE bucket = ? AND created_at >= ?`,
    )
      .bind(`${tier.action}:${login}`, now - tier.windowMs)
      .first<{ n: number; oldest: number | null }>();
    const count = row?.n ?? 0;
    if (count >= tier.limit) {
      const oldest = row?.oldest ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + tier.windowMs - now) / 1000));
      return { allowed: false, retryAfterSec };
    }
  }

  await env.DB.batch(
    tiers.map((tier) =>
      env.DB.prepare(`INSERT INTO rate_events (bucket, created_at) VALUES (?, ?)`).bind(
        `${tier.action}:${login}`,
        now,
      ),
    ),
  );
  return { allowed: true, retryAfterSec: 0 };
}

// Drop events older than the longest window; called from the daily cron so the
// append-only table doesn't grow unbounded.
export async function pruneRateEvents(env: Env, olderThan: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM rate_events WHERE created_at < ?`).bind(olderThan).run();
}
