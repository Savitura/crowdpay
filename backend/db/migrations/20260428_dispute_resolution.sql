-- Dispute resolution for campaigns
CREATE TABLE disputes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      UUID NOT NULL REFERENCES campaigns(id),
  raised_by        UUID NOT NULL REFERENCES users(id),
  reason           TEXT NOT NULL CHECK (reason IN ('non_delivery', 'misrepresentation', 'abandoned', 'other')),
  description      TEXT NOT NULL,
  evidence_url     TEXT,
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'under_review', 'resolved_creator', 'resolved_contributor', 'closed')),
  resolution_note  TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ,
  -- One open/under_review dispute per contributor per campaign
  CONSTRAINT disputes_one_active_per_contributor
    UNIQUE NULLS NOT DISTINCT (campaign_id, raised_by)
);

CREATE INDEX disputes_campaign_idx ON disputes (campaign_id);
CREATE INDEX disputes_status_idx   ON disputes (status);

-- Add on_hold status to withdrawal_requests
ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS dispute_id UUID REFERENCES disputes(id);

ALTER TABLE withdrawal_requests
  DROP CONSTRAINT IF EXISTS withdrawal_requests_status_check;

ALTER TABLE withdrawal_requests
  ADD CONSTRAINT withdrawal_requests_status_check
    CHECK (status IN ('pending', 'on_hold', 'submitted', 'failed', 'denied'));

-- Audit log for dispute actions
CREATE TABLE dispute_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id  UUID NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  actor_id    UUID REFERENCES users(id),
  action      TEXT NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX dispute_events_dispute_idx ON dispute_events (dispute_id, created_at ASC);
