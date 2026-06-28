-- Privacy / data-minimization: collapse the identity-linked scan log into an
-- aggregate-only counter, and PERMANENTLY purge the per-scan identity data.
--
-- The old `scans` table kept one row per scan run — (login, kind, target,
-- top_score, created_at), i.e. "user X scanned repo/account Y at time T". That
-- is an identity-linked activity log we no longer wish to retain. This migration:
--   1. creates scan_daily, an aggregate-only counter keyed by UTC day + kind;
--   2. backfills it from the existing rows, preserving the aggregate history
--      while discarding the identity (login / target / top_score);
--   3. drops the scans table outright. This is irreversible by design — purging
--      the login/target/top_score columns is the whole point. Its indexes
--      (idx_scans_login / created / kind / target from 0001 & 0005) drop with it.
--
-- Abuse "velocity" (a user's scans in the trailing 24h) is now derived from the
-- existing rate_events table (bucket 'scan-day:<login>'), so no per-scan identity
-- row is needed for that either (see src/users/store.ts).

CREATE TABLE IF NOT EXISTS scan_daily (
  day   TEXT    NOT NULL,            -- UTC calendar day, 'YYYY-MM-DD'
  kind  TEXT    NOT NULL,            -- 'self' | 'repo' | 'account' | 'clones'
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);

INSERT INTO scan_daily (day, kind, count)
  SELECT date(created_at / 1000, 'unixepoch'), kind, COUNT(*)
    FROM scans
   GROUP BY 1, 2;

DROP TABLE scans;
