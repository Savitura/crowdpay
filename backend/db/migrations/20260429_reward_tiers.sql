-- Migration: Reward Tiers and Backer Perks
-- Created at: 2026-04-29

CREATE TABLE reward_tiers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  description         TEXT,
  min_amount          NUMERIC(20, 7) NOT NULL,
  asset_type          TEXT NOT NULL, -- Must match campaign asset
  "limit"             INT,           -- NULL means unlimited
  claimed_count       INT NOT NULL DEFAULT 0,
  estimated_delivery  DATE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE contribution_rewards (
  contribution_id     UUID PRIMARY KEY REFERENCES contributions(id) ON DELETE CASCADE,
  reward_tier_id      UUID NOT NULL REFERENCES reward_tiers(id) ON DELETE CASCADE,
  claimed_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX reward_tiers_campaign_idx ON reward_tiers (campaign_id);
CREATE INDEX reward_tiers_min_amount_idx ON reward_tiers (min_amount);
CREATE INDEX contribution_rewards_tier_idx ON contribution_rewards (reward_tier_id);
