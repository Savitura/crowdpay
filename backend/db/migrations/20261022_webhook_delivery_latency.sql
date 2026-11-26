-- Add latency_ms column to webhook delivery tables to record delivery execution duration in milliseconds
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS latency_ms INT;
ALTER TABLE campaign_webhook_deliveries ADD COLUMN IF NOT EXISTS latency_ms INT;
