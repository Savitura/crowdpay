ALTER TABLE campaigns
ADD COLUMN IF NOT EXISTS velocity_alert_threshold NUMERIC(18, 7) DEFAULT 0;
