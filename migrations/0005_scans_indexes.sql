-- Indexes for the admin analytics aggregates over the scans table, which grows
-- unbounded (no retention sweep yet). Without these, every dashboard load does a
-- full table scan that gets slower as scans accumulate:
--   * countScansByKind (getAdminStats) GROUPs BY kind
--   * topScannedTargets (/admin/scans/top) GROUPs BY target
-- login and created_at are already indexed in 0001_baseline.sql.
CREATE INDEX IF NOT EXISTS idx_scans_kind ON scans (kind);
CREATE INDEX IF NOT EXISTS idx_scans_target ON scans (target);
