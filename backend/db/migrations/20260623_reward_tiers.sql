-- Reward tiers and backer perks for campaigns (issue #61).
--
-- Adds an optional reward/pledge system: a campaign can define 0-10 tiers,
-- each with a minimum contribution amount. When a contribution is indexed it
-- is matched to the highest tier it qualifies for that still has capacity.

CREATE TABLE reward_tiers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id        UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  description        TEXT,
  min_amount         NUMERIC(20, 7) NOT NULL CHECK (min_amount > 0),
  asset_type         TEXT NOT NULL CHECK (asset_type IN ('XLM', 'USDC')),
  -- NULL = unlimited claims; otherwise the max number of backers for this tier
  tier_limit         INTEGER CHECK (tier_limit IS NULL OR tier_limit > 0),
  claimed_count      INTEGER NOT NULL DEFAULT 0 CHECK (claimed_count >= 0),
  estimated_delivery DATE,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Join table: which reward tier a given contribution was matched to.
-- One contribution maps to at most one tier (UNIQUE), which also makes the
-- auto-assignment idempotent if the same contribution is indexed twice.
CREATE TABLE contribution_rewards (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id UUID NOT NULL UNIQUE REFERENCES contributions(id) ON DELETE CASCADE,
  reward_tier_id  UUID NOT NULL REFERENCES reward_tiers(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON reward_tiers (campaign_id);
CREATE INDEX ON contribution_rewards (reward_tier_id);
