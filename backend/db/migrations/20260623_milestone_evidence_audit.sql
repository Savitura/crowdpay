ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS evidence_description TEXT,
  ADD COLUMN IF NOT EXISTS evidence_submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewer_id UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

UPDATE milestones
SET evidence_submitted_at = completed_at
WHERE evidence_submitted_at IS NULL AND completed_at IS NOT NULL;

ALTER TABLE milestones DROP CONSTRAINT IF EXISTS milestones_status_check;
ALTER TABLE milestones
  ADD CONSTRAINT milestones_status_check
  CHECK (status IN ('pending', 'pending_review', 'rejected', 'approved', 'released'));

UPDATE milestones
SET status = 'pending_review'
WHERE status IN ('pending', 'approved')
  AND evidence_url IS NOT NULL
  AND released_at IS NULL;

CREATE TABLE IF NOT EXISTS milestone_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id UUID NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  actor_id     UUID REFERENCES users(id),
  action       TEXT NOT NULL,
  note         TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS milestone_events_milestone_idx
  ON milestone_events (milestone_id, created_at ASC);
