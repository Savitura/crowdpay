-- Feature flags table for incremental rollouts
CREATE TABLE feature_flags (
  key             TEXT PRIMARY KEY,
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  default_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  description     TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert default flags (all disabled by default)
INSERT INTO feature_flags (key, enabled, default_enabled, description) VALUES
  ('new_campaign_ui', false, false, 'Redesigned campaign creation flow'),
  ('embed_widget_v2', false, false, 'Next-generation embed widget'),
  ('recurring_donations', false, false, 'Monthly recurring contribution option'),
  ('nft_rewards_v2', false, false, 'Enhanced NFT reward mechanics')
ON CONFLICT (key) DO NOTHING;
