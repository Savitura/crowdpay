-- Up
CREATE TABLE IF NOT EXISTS payout_beneficiaries (
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  destination_key TEXT NOT NULL,
  requested_by UUID NOT NULL REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by UUID REFERENCES users(id),
  effective_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (campaign_id, destination_key),
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

