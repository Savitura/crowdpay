-- Issue #955: Contribution dedications and memorial messages
-- Allows a contributor to attach a dedication or memorial message to a
-- contribution. One dedication per contribution (UNIQUE on contribution_id).
-- The honoree_name and message are sanitized at the application layer before
-- persistence; the CHECK constraints here provide a hard DB-level safety net.

CREATE TABLE IF NOT EXISTS contribution_dedications (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id UUID        NOT NULL REFERENCES stellar_transactions(id) ON DELETE CASCADE,
  campaign_id     UUID        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id         UUID        REFERENCES users(id) ON DELETE SET NULL,
  honoree_name    TEXT        NOT NULL CHECK (char_length(honoree_name) BETWEEN 1 AND 100),
  message         TEXT        CHECK (char_length(message) <= 1000),
  dedication_type TEXT        NOT NULL DEFAULT 'in_honor_of'
                              CHECK (dedication_type IN ('in_honor_of', 'in_memory_of')),
  is_public       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One dedication per contribution
CREATE UNIQUE INDEX IF NOT EXISTS contribution_dedications_contribution_uniq
  ON contribution_dedications (contribution_id);

-- Fast lookup of all public dedications for a campaign (displayed on campaign page)
CREATE INDEX IF NOT EXISTS contribution_dedications_campaign_idx
  ON contribution_dedications (campaign_id, is_public, created_at DESC);

-- Fast lookup of a user's own dedications across campaigns
CREATE INDEX IF NOT EXISTS contribution_dedications_user_idx
  ON contribution_dedications (user_id);
