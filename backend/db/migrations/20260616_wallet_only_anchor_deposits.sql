ALTER TABLE anchor_deposits
  ALTER COLUMN campaign_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS deposit_type TEXT NOT NULL DEFAULT 'campaign'
    CHECK (deposit_type IN ('wallet', 'campaign'));
