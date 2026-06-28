-- Campaign webhooks: allow creators to register webhook URLs for contribution events
-- This is separate from the user-level webhooks table (which is for KYC integrations)

CREATE TABLE campaign_webhooks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  secret        TEXT NOT NULL,   -- HMAC signing secret (not hashed, creator manages it)
  events        TEXT[] NOT NULL DEFAULT ARRAY['contribution.indexed'],
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX campaign_webhooks_campaign_idx ON campaign_webhooks (campaign_id);
CREATE INDEX campaign_webhooks_active_idx ON campaign_webhooks (campaign_id, active)
  WHERE active = TRUE;

CREATE TABLE campaign_webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id      UUID NOT NULL REFERENCES campaign_webhooks(id) ON DELETE CASCADE,
  event           TEXT NOT NULL,
  payload         JSONB NOT NULL,
  response_status INT,
  delivered_at    TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  error           TEXT,
  attempt_count   INT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'retrying')),
  last_error      TEXT,
  next_retry_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX campaign_webhook_deliveries_webhook_idx ON campaign_webhook_deliveries (webhook_id);
CREATE INDEX campaign_webhook_deliveries_retry_idx
  ON campaign_webhook_deliveries (status, next_retry_at)
  WHERE status IN ('pending', 'retrying');
