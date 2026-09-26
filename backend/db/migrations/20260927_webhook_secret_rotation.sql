ALTER TABLE webhooks
  ADD COLUMN secret_version INT NOT NULL DEFAULT 1,
  ADD COLUMN previous_secret TEXT,
  ADD COLUMN previous_secret_hint TEXT,
  ADD COLUMN previous_secret_version INT,
  ADD COLUMN previous_secret_expires_at TIMESTAMPTZ;

ALTER TABLE webhook_deliveries
  ADD COLUMN signature_versions INT[];
