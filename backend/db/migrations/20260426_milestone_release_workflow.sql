CREATE TABLE IF NOT EXISTS milestones (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  description         TEXT,
  release_percentage  NUMERIC(7, 4) NOT NULL CHECK (release_percentage > 0 AND release_percentage <= 100),
  sort_order          INT NOT NULL DEFAULT 0,
  evidence_url        TEXT,
  destination_key     TEXT,
  review_note         TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'released')),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  approved_at         TIMESTAMPTZ,
  released_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS milestones_campaign_idx ON milestones (campaign_id);

ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS release_percentage NUMERIC(7, 4),
  ADD COLUMN IF NOT EXISTS evidence_url TEXT,
  ADD COLUMN IF NOT EXISTS destination_key TEXT,
  ADD COLUMN IF NOT EXISTS review_note TEXT,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;

UPDATE milestones
SET release_percentage = COALESCE(release_percentage, 100)
WHERE release_percentage IS NULL;

ALTER TABLE milestones
  ALTER COLUMN release_percentage SET NOT NULL;

ALTER TABLE milestones DROP CONSTRAINT IF EXISTS milestones_status_check;
ALTER TABLE milestones
  ADD CONSTRAINT milestones_status_check
  CHECK (status IN ('pending', 'approved', 'released'));

ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;
ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_status_check
  CHECK (status IN ('active', 'funded', 'in_progress', 'completed', 'closed', 'withdrawn', 'failed'));

ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS milestone_id UUID REFERENCES milestones(id);

CREATE INDEX IF NOT EXISTS withdrawal_requests_milestone_idx
  ON withdrawal_requests (milestone_id);

CREATE UNIQUE INDEX IF NOT EXISTS withdrawal_requests_milestone_unique_idx
  ON withdrawal_requests (milestone_id)
  WHERE milestone_id IS NOT NULL;
