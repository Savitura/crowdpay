BEGIN;

-- Allow reconciliation adjustments as a distinct contribution type so that
-- SUM(contributions.amount) always equals campaigns.raised_amount after
-- a reconciliation correction is applied (issue #324).
ALTER TABLE contributions
  DROP CONSTRAINT IF EXISTS contributions_payment_type_check;

ALTER TABLE contributions
  ADD CONSTRAINT contributions_payment_type_check
  CHECK (payment_type IN (
    'payment',
    'path_payment_strict_receive',
    'reconciliation_adjustment'
  ));

-- tx_hash has a UNIQUE NOT NULL constraint; reconciliation adjustments are
-- system-generated and have no Stellar transaction hash. Making the column
-- nullable lets us store NULL (each NULL is treated as distinct by the
-- UNIQUE index in PostgreSQL, so multiple adjustments are safe).
ALTER TABLE contributions
  ALTER COLUMN tx_hash DROP NOT NULL;

-- Index to make analytics queries on adjustment records fast.
CREATE INDEX IF NOT EXISTS contributions_payment_type_idx
  ON contributions (campaign_id, payment_type);

COMMIT;
