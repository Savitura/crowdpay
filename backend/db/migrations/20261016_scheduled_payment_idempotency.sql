ALTER TABLE recurring_payout_runs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS recurring_payout_runs_idempotency_key_idx
  ON recurring_payout_runs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;