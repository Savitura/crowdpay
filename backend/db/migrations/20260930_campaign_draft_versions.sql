-- Recoverable campaign draft version history (issue #942).
--
-- `campaigns.draft_version` is bumped on every autosave and used for optimistic
-- concurrency so two editor tabs cannot silently overwrite newer work. Material
-- edits additionally snapshot the editable content into
-- `campaign_draft_versions`. The ON DELETE CASCADE means retained versions are
-- removed automatically when a campaign is permanently deleted.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS draft_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS draft_saved_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS campaign_draft_versions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  author_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  version     INTEGER NOT NULL,
  reason      TEXT NOT NULL DEFAULT 'autosave'
                CHECK (reason IN ('autosave', 'manual', 'restore')),
  snapshot    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS campaign_draft_versions_campaign_version_idx
  ON campaign_draft_versions (campaign_id, version DESC);
