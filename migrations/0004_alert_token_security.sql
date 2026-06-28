-- Cron sharding + alert-token hardening.
--
-- last_scanned_at: cursor for cron sharding. The daily re-scan processes a
--   bounded batch ordered by least-recently-scanned (NULLs — never scanned —
--   first), so one invocation can't fan out over every subscriber and blow the
--   Workers per-invocation subrequest budget.
-- verify_expires_at: the email UI claims a confirmation link can "expire" but no
--   expiry existed. Verify tokens now carry one; verifyByToken rejects expired
--   ones. NULL (legacy rows) is treated as non-expiring.
--
-- verify_token / unsubscribe_token now hold a SHA-256 hash of the capability
-- token rather than the plaintext (the raw token lives only in the emailed URL).
-- No schema change is needed for that — the existing TEXT columns hold the hex
-- digest — but any pre-existing plaintext tokens are thereby invalidated
-- (acceptable pre-launch; affected users simply re-subscribe).
ALTER TABLE alert_subscriptions ADD COLUMN last_scanned_at INTEGER;
ALTER TABLE alert_subscriptions ADD COLUMN verify_expires_at INTEGER;

-- Index the sharding cursor so the ORDER BY last_scanned_at batch query stays cheap.
CREATE INDEX IF NOT EXISTS idx_alert_last_scanned ON alert_subscriptions (last_scanned_at);
