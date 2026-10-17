-- Contributor self-service refund requests (#946).
ALTER TABLE contributions
  ADD COLUMN IF NOT EXISTS refund_reserved_amount NUMERIC(20, 7) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS refund_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contribution_id UUID NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
  contributor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(20, 7) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'paid')),
  reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  rejection_reason TEXT,
  reviewed_at TIMESTAMPTZ,
  settlement_claimed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS refund_requests_active_contribution_idx
  ON refund_requests(contribution_id)
  WHERE status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS refund_requests_campaign_status_idx
  ON refund_requests(campaign_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS refund_requests_contributor_idx
  ON refund_requests(contributor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS refund_request_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES refund_requests(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS refund_request_events_request_idx
  ON refund_request_events(request_id, created_at);
