-- Per-campaign opt-out for campaign update notification emails (#279)
CREATE TABLE IF NOT EXISTS campaign_update_unsubscribes (
  email           TEXT NOT NULL,
  campaign_id     INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  unsubscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (email, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_update_unsubscribes_campaign
  ON campaign_update_unsubscribes (campaign_id);
