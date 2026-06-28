CREATE TABLE IF NOT EXISTS campaign_members (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  email             TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'editor', 'viewer')),
  invited_by        UUID REFERENCES users(id),
  invite_token      TEXT UNIQUE,
  invite_expires_at TIMESTAMPTZ,
  accepted_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (campaign_id, email)
);

CREATE INDEX IF NOT EXISTS campaign_members_campaign_idx
  ON campaign_members (campaign_id);

CREATE INDEX IF NOT EXISTS campaign_members_pending_idx
  ON campaign_members (campaign_id)
  WHERE accepted_at IS NULL;
