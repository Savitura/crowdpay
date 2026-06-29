-- Migration: Create withdrawal_requests table

CREATE TABLE withdrawal_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         UUID NOT NULL REFERENCES campaigns(id),
  requested_by        UUID NOT NULL REFERENCES users(id),
  amount              NUMERIC(20, 7) NOT NULL,
  destination_key     TEXT NOT NULL,
  unsigned_xdr        TEXT NOT NULL,  -- transaction XDR waiting for signatures
  creator_signed      BOOLEAN DEFAULT FALSE,
  platform_signed     BOOLEAN DEFAULT FALSE,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'submitted', 'failed', 'denied')),
  denial_reason       TEXT,
  tx_hash             TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
