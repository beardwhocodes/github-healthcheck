-- Cover the admin filter/sort queries that previously full-scanned.
-- admin_audit: WHERE action = 'login' / action <> 'login' ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_audit_action ON admin_audit (action, created_at);

-- reported_repos: WHERE status = ? ORDER BY updated_at DESC (the admin Reports list)
CREATE INDEX IF NOT EXISTS idx_reports_status_updated ON reported_repos (status, updated_at);

-- messages: WHERE status = ? ORDER BY created_at DESC (the admin Inbox)
CREATE INDEX IF NOT EXISTS idx_messages_status_created ON messages (status, created_at);
