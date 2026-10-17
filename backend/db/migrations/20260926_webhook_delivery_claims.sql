-- Concurrency-safe webhook delivery processing (#838)
--
-- A worker must atomically claim a delivery (conditional UPDATE to
-- status = 'delivering') before any network I/O. The claim records a
-- per-attempt lease token and expiry so that:
--   * only the lease holder may record the attempt's outcome, and
--   * a worker that crashes mid-attempt leaves a lease the poller can
--     reclaim once it expires, instead of a row stuck in 'delivering'.

ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS lease_token      TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

ALTER TABLE campaign_webhook_deliveries
  ADD COLUMN IF NOT EXISTS lease_token      TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

-- The retry poller scans for due retries, stale pending rows and expired
-- leases; widen the partial retry indexes to cover in-flight rows.
DROP INDEX IF EXISTS webhook_deliveries_retry_idx;
CREATE INDEX webhook_deliveries_retry_idx
  ON webhook_deliveries (status, next_retry_at)
  WHERE status IN ('pending', 'retrying', 'delivering');

DROP INDEX IF EXISTS campaign_webhook_deliveries_retry_idx;
CREATE INDEX campaign_webhook_deliveries_retry_idx
  ON campaign_webhook_deliveries (status, next_retry_at)
  WHERE status IN ('pending', 'retrying', 'delivering');
