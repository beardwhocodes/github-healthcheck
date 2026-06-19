-- GitHub Healthcheck D1 schema. Apply with:
--   wrangler d1 execute github-healthcheck-db --local  --file=./src/db/schema.sql
--   wrangler d1 execute github-healthcheck-db --remote --file=./src/db/schema.sql

-- Server-side sessions. The GitHub token is stored AES-GCM encrypted (token_enc);
-- only an opaque session id is ever placed in the browser cookie.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  login       TEXT NOT NULL,
  name        TEXT,
  avatar_url  TEXT NOT NULL,
  scopes      TEXT NOT NULL DEFAULT '',
  token_enc   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- A user's standing subscription to future-impersonation alerts. Stores an
-- encrypted long-lived token so the daily cron can re-search on their behalf.
CREATE TABLE IF NOT EXISTS alert_subscriptions (
  login       TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  token_enc   TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  last_run_at INTEGER
);

-- The repos we watch for each subscriber (their own repositories).
CREATE TABLE IF NOT EXISTS watched_repos (
  login     TEXT NOT NULL,
  full_name TEXT NOT NULL,
  PRIMARY KEY (login, full_name)
);

-- Baseline of clones we've already seen, so the cron only alerts on NEW ones.
CREATE TABLE IF NOT EXISTS known_clones (
  login        TEXT NOT NULL,
  source_repo  TEXT NOT NULL,
  suspect_repo TEXT NOT NULL,
  confidence   INTEGER NOT NULL,
  first_seen   INTEGER NOT NULL,
  notified     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (login, suspect_repo)
);
CREATE INDEX IF NOT EXISTS idx_known_clones_login ON known_clones (login);
