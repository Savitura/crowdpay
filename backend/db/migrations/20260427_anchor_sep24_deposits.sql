ALTER TABLE contributions
  ADD COLUMN IF NOT EXISTS anchor_id TEXT,
  ADD COLUMN IF NOT EXISTS anchor_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS anchor_asset TEXT,
  ADD COLUMN IF NOT EXISTS anchor_amount NUMERIC(20, 7);

CREATE UNIQUE INDEX IF NOT EXISTS contributions_anchor_transaction_idx
  ON contributions (anchor_id, anchor_transaction_id)
  WHERE anchor_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS anchor_deposits (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id                 UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  anchor_id                   TEXT NOT NULL,
  anchor_transaction_id       TEXT NOT NULL,
  anchor_asset                TEXT NOT NULL,
  anchor_amount               NUMERIC(20, 7) NOT NULL,
  campaign_asset              TEXT NOT NULL,
  contribution_amount         NUMERIC(20, 7) NOT NULL,
  contribution_flow           JSONB NOT NULL DEFAULT '{}',
  conversion_quote            JSONB,
  interactive_url             TEXT NOT NULL,
  anchor_auth_token           TEXT,
  anchor_auth_expires_at      TIMESTAMPTZ,
  status                      TEXT NOT NULL DEFAULT 'pending_anchor'
                                CHECK (status IN (
                                  'pending_anchor',
                                  'deposit_completed',
                                  'contribution_submitted',
                                  'completed',
                                  'failed'
                                )),
  last_anchor_status          TEXT,
  last_anchor_payload         JSONB,
  last_error                  TEXT,
  contribution_tx_hash        TEXT,
  contribution_stellar_transaction_id UUID REFERENCES stellar_transactions(id),
  contribution_id             UUID REFERENCES contributions(id),
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW(),
  completed_at                TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS anchor_deposits_anchor_tx_idx
  ON anchor_deposits (anchor_id, anchor_transaction_id);
CREATE INDEX IF NOT EXISTS anchor_deposits_user_created_idx
  ON anchor_deposits (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS anchor_deposits_campaign_created_idx
  ON anchor_deposits (campaign_id, created_at DESC);
