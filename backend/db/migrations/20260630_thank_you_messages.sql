CREATE TABLE thank_you_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  creator_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contribution_id UUID REFERENCES contributions(id) ON DELETE SET NULL,
  message         TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('bulk', 'individual')),
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_thank_you_campaign_id ON thank_you_messages (campaign_id);
CREATE INDEX idx_thank_you_creator_id ON thank_you_messages (creator_id);
CREATE INDEX idx_thank_you_contribution_id ON thank_you_messages (contribution_id);

CREATE TABLE thank_you_unsubscribes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,
  campaign_id     UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  unsubscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_thank_you_unsub_email_global ON thank_you_unsubscribes (email) WHERE campaign_id IS NULL;
CREATE UNIQUE INDEX idx_thank_you_unsub_email_campaign ON thank_you_unsubscribes (email, campaign_id) WHERE campaign_id IS NOT NULL;
