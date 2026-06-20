-- Analytics indexes for campaign performance dashboard (#243)
-- Covers: daily bucket queries, contributor lookups, creator-wide aggregates

-- Index contributions by (campaign_id, created_at) for daily bucket queries
CREATE INDEX IF NOT EXISTS idx_contributions_campaign_created
  ON contributions (campaign_id, created_at);

-- Index contributions by sender for contributor queries
CREATE INDEX IF NOT EXISTS idx_contributions_sender
  ON contributions (sender_public_key);

-- Index campaigns by creator + raised_amount for user dashboard aggregates
CREATE INDEX IF NOT EXISTS idx_campaigns_creator_raised
  ON campaigns (creator_id, raised_amount DESC);

-- Country on user profiles (no new data collection — optional self-reported field)
ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT;
