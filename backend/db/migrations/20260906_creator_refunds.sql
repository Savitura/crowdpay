-- Creator-initiated individual refund support (#757)
CREATE TABLE IF NOT EXISTS creator_refunds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contribution_id UUID REFERENCES contributions(id) ON DELETE SET NULL,
  recipient_wallet TEXT NOT NULL,
  amount        NUMERIC(20, 7) NOT NULL,
  asset         TEXT NOT NULL DEFAULT 'native',
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  processed_at  TIMESTAMPTZ,
  stellar_tx_hash TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS creator_refunds_campaign_idx ON creator_refunds(campaign_id);
CREATE INDEX IF NOT EXISTS creator_refunds_status_idx ON creator_refunds(status);
CREATE INDEX IF NOT EXISTS creator_refunds_contribution_idx ON creator_refunds(contribution_id);
