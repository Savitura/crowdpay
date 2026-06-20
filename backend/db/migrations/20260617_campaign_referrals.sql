CREATE TABLE campaign_referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  referrer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referral_code TEXT NOT NULL,
  click_count INTEGER NOT NULL DEFAULT 0,
  contribution_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_campaign_referrals_campaign_id ON campaign_referrals(campaign_id);
CREATE UNIQUE INDEX idx_campaign_referrals_code ON campaign_referrals(referral_code);
CREATE UNIQUE INDEX idx_campaign_referrals_user_campaign ON campaign_referrals(campaign_id, referrer_user_id);
