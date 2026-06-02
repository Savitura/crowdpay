-- Creator-initiated campaign batch refund mechanism database changes
ALTER TABLE campaigns
  ADD COLUMN refund_initiated_at TIMESTAMPTZ,
  ADD COLUMN refund_tx_hash TEXT,
  ADD COLUMN refund_xdr TEXT;

ALTER TABLE contributions
  ADD COLUMN refunded BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE campaigns
  DROP CONSTRAINT IF EXISTS campaigns_status_check;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_status_check
    CHECK (status IN ('active', 'funded', 'in_progress', 'completed', 'closed', 'withdrawn', 'failed', 'refunded'));
