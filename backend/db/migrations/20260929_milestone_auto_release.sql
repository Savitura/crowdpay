-- Automatic milestone release on verified evidence, gated by a dispute window (#930).
--
-- A creator opts a milestone into auto-release before submitting evidence,
-- choosing a verification rule and a dispute window. When evidence that
-- satisfies the rule is submitted, the release is scheduled for
-- auto_release_at; any backer can open a dispute before then, which halts it.
-- The worker (services/milestoneAutoRelease.js) fires due releases.
--
-- The dispute window can be shortened by the creator but never removed: the
-- 24-hour floor (MILESTONE_AUTO_RELEASE_MIN_WINDOW_SECONDS) is enforced here as
-- well as in the API so that a compromised app server cannot schedule an
-- immediate release.

ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS auto_release_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_release_rule TEXT,
  ADD COLUMN IF NOT EXISTS auto_release_rule_config JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS auto_release_window_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS auto_release_status TEXT,
  ADD COLUMN IF NOT EXISTS auto_release_configured_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_release_scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_release_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_release_evidence_url TEXT,
  ADD COLUMN IF NOT EXISTS auto_release_evidence_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS auto_release_halted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_release_halt_reason TEXT,
  ADD COLUMN IF NOT EXISTS auto_release_dispute_id UUID REFERENCES disputes(id),
  ADD COLUMN IF NOT EXISTS release_trigger TEXT;

ALTER TABLE milestones DROP CONSTRAINT IF EXISTS milestones_auto_release_rule_check;
ALTER TABLE milestones
  ADD CONSTRAINT milestones_auto_release_rule_check
  CHECK (auto_release_rule IS NULL OR auto_release_rule IN (
    'platform_evidence', 'evidence_hash_commitment', 'backer_approval'
  ));

ALTER TABLE milestones DROP CONSTRAINT IF EXISTS milestones_auto_release_window_min_check;
ALTER TABLE milestones
  ADD CONSTRAINT milestones_auto_release_window_min_check
  CHECK (auto_release_window_seconds IS NULL OR auto_release_window_seconds >= 86400);

ALTER TABLE milestones DROP CONSTRAINT IF EXISTS milestones_auto_release_enabled_check;
ALTER TABLE milestones
  ADD CONSTRAINT milestones_auto_release_enabled_check
  CHECK (NOT auto_release_enabled
         OR (auto_release_rule IS NOT NULL AND auto_release_window_seconds IS NOT NULL));

ALTER TABLE milestones DROP CONSTRAINT IF EXISTS milestones_auto_release_status_check;
ALTER TABLE milestones
  ADD CONSTRAINT milestones_auto_release_status_check
  CHECK (auto_release_status IS NULL OR auto_release_status IN (
    'awaiting_evidence', 'scheduled', 'halted', 'ineligible', 'releasing',
    'released', 'failed', 'cancelled', 'superseded'
  ));

-- A scheduled release must always leave at least the minimum dispute window.
ALTER TABLE milestones DROP CONSTRAINT IF EXISTS milestones_auto_release_schedule_check;
ALTER TABLE milestones
  ADD CONSTRAINT milestones_auto_release_schedule_check
  CHECK (auto_release_status IS DISTINCT FROM 'scheduled'
         OR (auto_release_scheduled_at IS NOT NULL
             AND auto_release_at >= auto_release_scheduled_at + INTERVAL '24 hours'));

ALTER TABLE milestones DROP CONSTRAINT IF EXISTS milestones_release_trigger_check;
ALTER TABLE milestones
  ADD CONSTRAINT milestones_release_trigger_check
  CHECK (release_trigger IS NULL OR release_trigger IN ('manual', 'auto'));

UPDATE milestones SET release_trigger = 'manual'
WHERE status = 'released' AND release_trigger IS NULL;

CREATE INDEX IF NOT EXISTS milestones_auto_release_due_idx
  ON milestones (auto_release_at)
  WHERE auto_release_status = 'scheduled';

-- Disputes raised against a specific pending release point at it.
ALTER TABLE disputes
  ADD COLUMN IF NOT EXISTS milestone_id UUID REFERENCES milestones(id);

-- One row per automated release. The UNIQUE milestone_id is the idempotency
-- anchor: a milestone can only ever have one automated payout transaction.
-- The signed XDR and its hash are persisted *before* submission, so a worker
-- that restarts mid-release reconciles against Horizon by hash instead of
-- building (and paying) a second transaction.
CREATE TABLE IF NOT EXISTS milestone_auto_release_attempts (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id           UUID NOT NULL UNIQUE REFERENCES milestones(id) ON DELETE CASCADE,
  campaign_id            UUID NOT NULL REFERENCES campaigns(id),
  rule                   TEXT NOT NULL,
  rule_config            JSONB NOT NULL DEFAULT '{}',
  window_seconds         INTEGER NOT NULL CHECK (window_seconds >= 86400),
  scheduled_at           TIMESTAMPTZ NOT NULL,
  fires_at               TIMESTAMPTZ NOT NULL,
  evidence_url           TEXT NOT NULL,
  evidence_sha256        TEXT,
  amount                 NUMERIC(20, 7) NOT NULL,
  destination_key        TEXT NOT NULL,
  signed_xdr             TEXT,
  tx_hash                TEXT,
  status                 TEXT NOT NULL DEFAULT 'claimed'
                           CHECK (status IN ('claimed', 'prepared', 'submitted', 'confirmed', 'failed')),
  failure_reason         TEXT,
  lease_until            TIMESTAMPTZ,
  withdrawal_request_id  UUID REFERENCES withdrawal_requests(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS milestone_auto_release_attempts_inflight_idx
  ON milestone_auto_release_attempts (lease_until)
  WHERE status IN ('claimed', 'prepared', 'submitted');
