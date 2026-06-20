-- Per-user rate limiting. One row per accepted request against a (bucket) key,
-- where bucket = "<action>:<login>". The limiter counts rows inside a sliding
-- window and inserts a new one when a request is allowed; the daily cron prunes
-- rows older than the longest window. Append-only + index-covered so the count
-- query stays cheap.
CREATE TABLE IF NOT EXISTS rate_events (
  bucket     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_events_bucket ON rate_events (bucket, created_at);
