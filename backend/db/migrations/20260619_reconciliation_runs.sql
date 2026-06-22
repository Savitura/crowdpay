-- Persist a summary row per reconciliation cron run, for the admin platform health panel

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at        TIMESTAMPTZ NOT NULL,
  finished_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  campaigns_checked INT NOT NULL,
  mismatches_found  INT NOT NULL,
  details           JSONB
);

CREATE INDEX IF NOT EXISTS reconciliation_runs_finished_idx ON reconciliation_runs (finished_at DESC);
