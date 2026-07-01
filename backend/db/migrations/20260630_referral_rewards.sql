-- Referral reward distribution and tiered bonuses (Issue #431)
--
-- Tracks earned and paid-out rewards for referrers, with support for
-- tiered bonus structure based on referral performance.

CREATE TABLE referral_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  referral_code TEXT NOT NULL,
  reward_type TEXT NOT NULL CHECK (reward_type IN ('credit', 'token_drop')),
  amount NUMERIC(20, 7) NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('XLM', 'USDC')),
  status TEXT NOT NULL DEFAULT 'earned' CHECK (status IN ('earned', 'paid_out', 'cancelled')),
  tier_level INTEGER NOT NULL DEFAULT 1,
  earned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_out_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX referral_rewards_referrer_idx ON referral_rewards (referrer_user_id, earned_at DESC);
CREATE INDEX referral_rewards_referred_idx ON referral_rewards (referred_user_id);
CREATE INDEX referral_rewards_campaign_idx ON referral_rewards (campaign_id);
CREATE INDEX referral_rewards_status_idx ON referral_rewards (status);
CREATE INDEX referral_rewards_tier_idx ON referral_rewards (tier_level);

-- Fraud detection: track IP and device fingerprints for referrals
CREATE TABLE referral_fraud_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_address INET,
  device_fingerprint TEXT,
  user_agent TEXT,
  fraud_type TEXT NOT NULL CHECK (fraud_type IN ('same_person', 'ip_clustering', 'device_clustering')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  notes TEXT
);

CREATE INDEX referral_fraud_checks_referrer_idx ON referral_fraud_checks (referrer_user_id, detected_at DESC);
CREATE INDEX referral_fraud_checks_ip_idx ON referral_fraud_checks (ip_address) WHERE ip_address IS NOT NULL;
CREATE INDEX referral_fraud_checks_fingerprint_idx ON referral_fraud_checks (device_fingerprint) WHERE device_fingerprint IS NOT NULL;