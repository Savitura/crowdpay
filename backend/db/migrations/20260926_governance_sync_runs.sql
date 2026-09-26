-- Governance synchronization run history (#839)
--
-- One row per synchronization run (scheduled, manual, or retry). A row is
-- written when the run starts ('running') and finalized exactly once
-- ('succeeded' or 'failed'); after that it is immutable. Concurrent triggers
-- are deduplicated by the partial unique index: at most one run can be
-- 'running' at a time, and a deduplicated trigger does not create a run.
-- A retry is a new row linked to the failed run it retries; each failed run
-- can be retried at most once (repeat requests return that retry).

BEGIN;

CREATE TABLE IF NOT EXISTS governance_sync_runs (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger            TEXT        NOT NULL CHECK (trigger IN ('scheduled', 'manual', 'retry')),
  status             TEXT        NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running', 'succeeded', 'failed')),
  -- No ON DELETE action: retention purges leaf runs first (see purgeExpiredRuns).
  retry_of_run_id    UUID        REFERENCES governance_sync_runs(id),
  requested_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at        TIMESTAMPTZ,
  proposals_seen     INTEGER     NOT NULL DEFAULT 0 CHECK (proposals_seen >= 0),
  proposals_updated  INTEGER     NOT NULL DEFAULT 0 CHECK (proposals_updated >= 0),
  proposals_missing  INTEGER     NOT NULL DEFAULT 0 CHECK (proposals_missing >= 0),
  provider_cursor    TEXT,
  error_code         TEXT,
  error_message      TEXT,
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK (status <> 'failed' OR error_code IS NOT NULL),
  CHECK ((trigger = 'retry') = (retry_of_run_id IS NOT NULL))
);

-- Concurrency policy: a single in-flight run.
CREATE UNIQUE INDEX IF NOT EXISTS governance_sync_runs_one_running_idx
  ON governance_sync_runs ((true))
  WHERE status = 'running';

-- Idempotent retry: a failed run has at most one retry.
CREATE UNIQUE INDEX IF NOT EXISTS governance_sync_runs_retry_of_idx
  ON governance_sync_runs (retry_of_run_id)
  WHERE retry_of_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS governance_sync_runs_started_idx
  ON governance_sync_runs (started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS governance_sync_runs_status_started_idx
  ON governance_sync_runs (status, started_at DESC);

-- Finished runs are immutable history. The only permitted updates are the
-- single transition out of 'running' and anonymizing requested_by when the
-- operator's user row is deleted (ON DELETE SET NULL).
CREATE OR REPLACE FUNCTION governance_sync_runs_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.requested_by IS NULL AND OLD.requested_by IS NOT NULL
     AND (to_jsonb(NEW) - 'requested_by') = (to_jsonb(OLD) - 'requested_by') THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'governance_sync_runs % is finished and immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.trigger <> OLD.trigger
     OR NEW.started_at <> OLD.started_at
     OR NEW.retry_of_run_id IS DISTINCT FROM OLD.retry_of_run_id
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by THEN
    RAISE EXCEPTION 'governance_sync_runs identity columns are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS governance_sync_runs_immutable_trg ON governance_sync_runs;
CREATE TRIGGER governance_sync_runs_immutable_trg
  BEFORE UPDATE ON governance_sync_runs
  FOR EACH ROW EXECUTE FUNCTION governance_sync_runs_immutable();

COMMIT;
