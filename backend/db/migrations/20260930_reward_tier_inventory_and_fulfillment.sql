-- Reward-tier inventory and fulfillment tracking (issue #958).
ALTER TABLE reward_tiers
  ADD COLUMN IF NOT EXISTS inventory_limit INTEGER CHECK (inventory_limit IS NULL OR inventory_limit > 0),
  ADD COLUMN IF NOT EXISTS inventory_claimed INTEGER NOT NULL DEFAULT 0 CHECK (inventory_claimed >= 0),
  ADD COLUMN IF NOT EXISTS fulfillment_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS fulfillment_instructions TEXT;

CREATE TABLE IF NOT EXISTS reward_fulfillments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id UUID NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
  reward_tier_id UUID NOT NULL REFERENCES reward_tiers(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','shipped','delivered','cancelled','refunded')),
  shipping_name TEXT, shipping_address_line1 TEXT, shipping_address_line2 TEXT,
  shipping_city TEXT, shipping_region TEXT, shipping_postal_code TEXT, shipping_country TEXT,
  tracking_number TEXT, carrier TEXT, notes TEXT,
  fulfilled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (contribution_id, reward_tier_id)
);
CREATE INDEX IF NOT EXISTS reward_fulfillments_campaign_status_idx ON reward_fulfillments (campaign_id, status);
CREATE INDEX IF NOT EXISTS reward_fulfillments_user_idx ON reward_fulfillments (user_id, status);
CREATE INDEX IF NOT EXISTS reward_fulfillments_tier_idx ON reward_fulfillments (reward_tier_id, status);

CREATE TABLE IF NOT EXISTS reward_tier_inventory_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reward_tier_id UUID NOT NULL REFERENCES reward_tiers(id) ON DELETE CASCADE,
  contribution_id UUID NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','claimed','released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (reward_tier_id, contribution_id)
);
CREATE INDEX IF NOT EXISTS reward_tier_inventory_reservations_tier_idx ON reward_tier_inventory_reservations (reward_tier_id, status);

CREATE OR REPLACE FUNCTION claim_reward_tier_inventory(p_reward_tier_id UUID, p_quantity INTEGER DEFAULT 1)
RETURNS BOOLEAN AS $$
DECLARE v_limit INTEGER; v_claimed INTEGER;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'p_quantity must be positive'; END IF;
  SELECT inventory_limit, inventory_claimed INTO v_limit, v_claimed FROM reward_tiers WHERE id = p_reward_tier_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reward tier not found'; END IF;
  IF v_limit IS NULL THEN
    UPDATE reward_tiers SET inventory_claimed = inventory_claimed + p_quantity WHERE id = p_reward_tier_id;
    RETURN TRUE;
  END IF;
  IF v_claimed + p_quantity > v_limit THEN RETURN FALSE; END IF;
  UPDATE reward_tiers SET inventory_claimed = inventory_claimed + p_quantity WHERE id = p_reward_tier_id;
  RETURN TRUE;
END; $$ LANGUAGE plpgsql;
