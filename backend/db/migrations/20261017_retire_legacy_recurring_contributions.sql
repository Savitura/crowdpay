BEGIN;

-- Keep old schedule rows for export/history, but never charge them again.
ALTER TABLE recurring_contributions
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

UPDATE recurring_contributions
SET active = FALSE,
    retired_at = COALESCE(retired_at, NOW()),
    updated_at = NOW()
WHERE active = TRUE;

COMMIT;