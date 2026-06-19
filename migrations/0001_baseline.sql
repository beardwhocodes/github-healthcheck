-- Baseline migration: the full schema as of the admin back-end.
--
-- Applied by `wrangler d1 migrations apply` (locally and in CI), which records
-- each migration in the d1_migrations table and runs it exactly once. Every
-- statement here is idempotent (CREATE ... IF NOT EXISTS) so this baseline can
-- safely ADOPT the pre-existing production database — which already has all of
-- these tables — on the first `migrations apply` without erroring. Fresh
-- databases get the complete, current schema (including the alert_subscriptions
-- double opt-in columns, which previously had to be added by a manual ALTER).
--
-- Future schema changes go in NEW numbered files (e.g. 0002_*.sql) as plain
-- ALTER/CREATE statements; the migration runner guarantees they apply once.

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
-- Double opt-in: a subscription is only emailed once `verified = 1`. The
-- verify/unsubscribe tokens are unguessable capability tokens used by the public
-- (no-login) /email/* routes.
CREATE TABLE IF NOT EXISTS alert_subscriptions (
  login             TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  token_enc         TEXT NOT NULL,
  active            INTEGER NOT NULL DEFAULT 1,
  verified          INTEGER NOT NULL DEFAULT 0,
  verify_token      TEXT,
  unsubscribe_token TEXT,
  verified_at       INTEGER,
  created_at        INTEGER NOT NULL,
  last_run_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alert_verify_token ON alert_subscriptions (verify_token);
CREATE INDEX IF NOT EXISTS idx_alert_unsub_token ON alert_subscriptions (unsubscribe_token);

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

-- ── Admin back-end ─────────────────────────────────────────────────────────

-- One row per GitHub account that has ever signed in. `role` gates the admin
-- dashboard; a non-null `suspended_at` blocks scanning (but not sign-in). The
-- bootstrap admin (src/admin/constants.ts) is always re-promoted on sign-in.
CREATE TABLE IF NOT EXISTS users (
  login            TEXT PRIMARY KEY,
  name             TEXT,
  avatar_url       TEXT,
  role             TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
  suspended_at     INTEGER,                         -- NULL = active
  suspended_reason TEXT,
  suspended_by     TEXT,
  includes_private INTEGER NOT NULL DEFAULT 0,      -- last-known: granted 'repo' scope
  scan_count       INTEGER NOT NULL DEFAULT 0,
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users (last_seen_at);
CREATE INDEX IF NOT EXISTS idx_users_suspended ON users (suspended_at);

-- One row per scan run, powering analytics and abuse detection (scan velocity).
CREATE TABLE IF NOT EXISTS scans (
  id         TEXT PRIMARY KEY,
  login      TEXT NOT NULL,
  kind       TEXT NOT NULL,        -- 'self' | 'repo' | 'account' | 'clones'
  target     TEXT,                 -- repo/account scanned (NULL for self-audit)
  top_score  INTEGER,              -- worst risk score observed in the run
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scans_login ON scans (login);
CREATE INDEX IF NOT EXISTS idx_scans_created ON scans (created_at);

-- Support inbox: questions/issues submitted by signed-in users via the contact
-- form. Two-way — an admin reply is stored here and emailed to the user.
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  login       TEXT NOT NULL,
  email       TEXT,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'read' | 'resolved'
  admin_reply TEXT,
  replied_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages (status);
CREATE INDEX IF NOT EXISTS idx_messages_login ON messages (login);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);

-- Audit trail of repos users have reported to GitHub as malicious/impersonating,
-- so an admin can observe and triage them. One row per (reporter, suspect repo).
CREATE TABLE IF NOT EXISTS reported_repos (
  id             TEXT PRIMARY KEY,
  reporter_login TEXT NOT NULL,
  suspect_repo   TEXT NOT NULL,
  suspect_url    TEXT,
  source_repo    TEXT,
  confidence     INTEGER,
  category       TEXT,                            -- 'malware' | 'impersonation'
  status         TEXT NOT NULL DEFAULT 'reported', -- reported|reviewing|confirmed|dismissed|takendown
  admin_notes    TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_reporter_suspect
  ON reported_repos (reporter_login, suspect_repo);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reported_repos (status);
CREATE INDEX IF NOT EXISTS idx_reports_suspect ON reported_repos (suspect_repo);

-- Every consequential admin action, for accountability.
CREATE TABLE IF NOT EXISTS admin_audit (
  id          TEXT PRIMARY KEY,
  admin_login TEXT NOT NULL,
  action      TEXT NOT NULL,    -- suspend_user|unsuspend_user|set_role|update_message|reply_message|update_report
  target      TEXT,             -- login, repo, or record id the action applied to
  detail      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_admin ON admin_audit (admin_login);
