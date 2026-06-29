-- Migration: Create missing base tables from schema.sql that were omitted in early migrations

-- Unified on-chain audit + reporting index for Stellar flows (contributions, withdrawals)
CREATE TABLE IF NOT EXISTS stellar_transactions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                    TEXT NOT NULL CHECK (kind IN ('contribution', 'withdrawal')),
  status                  TEXT NOT NULL CHECK (status IN (
                            'pending_signatures',
                            'submitted',
                            'indexed',
                            'failed'
                          )),
  tx_hash                 TEXT UNIQUE,
  campaign_id             UUID NOT NULL REFERENCES campaigns(id),
  withdrawal_request_id   UUID REFERENCES withdrawal_requests(id),
  initiated_by_user_id    UUID REFERENCES users(id),
  unsigned_xdr            TEXT,
  signed_xdr              TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}',
  contribution_id         UUID REFERENCES contributions(id),
  failure_reason          TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT stellar_transactions_kind_withdrawal_chk CHECK (
    (kind = 'withdrawal' AND withdrawal_request_id IS NOT NULL)
    OR (kind = 'contribution' AND withdrawal_request_id IS NULL)
  ),
  CONSTRAINT stellar_transactions_withdrawal_no_contribution_chk CHECK (
    (kind = 'withdrawal' AND contribution_id IS NULL)
    OR kind = 'contribution'
  )
);

CREATE INDEX IF NOT EXISTS stellar_transactions_campaign_created_idx
  ON stellar_transactions (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stellar_transactions_status_idx ON stellar_transactions (status);
CREATE INDEX IF NOT EXISTS stellar_transactions_tx_hash_idx ON stellar_transactions (tx_hash);
CREATE INDEX IF NOT EXISTS stellar_transactions_withdrawal_idx ON stellar_transactions (withdrawal_request_id);

-- Integrations: API keys (server-to-server) and outbound webhooks
CREATE TABLE IF NOT EXISTS api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_prefix      TEXT NOT NULL,
  key_hash        TEXT NOT NULL UNIQUE,
  label           TEXT NOT NULL DEFAULT '',
  scopes          TEXT[] NOT NULL DEFAULT ARRAY['read', 'write', 'withdrawals'],
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_keys_user_active_idx ON api_keys (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS webhooks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  events          TEXT[] NOT NULL,
  secret          TEXT NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS webhooks_user_active_idx ON webhooks (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id            UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type            TEXT NOT NULL,
  payload               JSONB NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'retrying')),
  response_status       INT,
  response_body_snippet TEXT,
  attempt_count         INT NOT NULL DEFAULT 0,
  last_error            TEXT,
  next_retry_at         TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_idx ON webhook_deliveries (webhook_id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_retry_idx
  ON webhook_deliveries (status, next_retry_at)
  WHERE status IN ('pending', 'retrying');
