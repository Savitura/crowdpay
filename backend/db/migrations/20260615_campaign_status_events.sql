-- Audit trail for campaign status transitions (funded / failed lifecycle events)
CREATE TABLE campaign_status_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  previous_status  TEXT NOT NULL,
  new_status       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaign_status_events_new_status_check
    CHECK (new_status IN ('funded', 'failed')),
  CONSTRAINT campaign_status_events_unique_transition
    UNIQUE (campaign_id, new_status)
);

CREATE INDEX campaign_status_events_campaign_idx ON campaign_status_events (campaign_id);
CREATE INDEX campaign_status_events_created_at_idx ON campaign_status_events (created_at DESC);
