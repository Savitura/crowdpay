-- Add fraud detection and IP tracking columns

ALTER TABLE contributions
  ADD COLUMN ip_address TEXT;

ALTER TABLE campaigns
  ADD COLUMN is_flagged_fraud BOOLEAN DEFAULT FALSE,
  ADD COLUMN fraud_score INTEGER DEFAULT 0,
  ADD COLUMN fraud_signals JSONB DEFAULT '{}'::jsonb;
