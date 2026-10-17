-- Close future recurring installments when their campaign stops accepting
-- them (#837).
--
-- A campaign accepts subscription installments only while it is 'active',
-- not soft-deleted, and the installment falls on or before its deadline.
-- Unclaimed installments outside that window move to 'closed': the row (and
-- its stellar_balance_id) is kept, the platform never claims it, and the
-- contributor's on-ledger reclaim predicate (scheduled_date + 30 days) is the
-- path for getting the funds back. reclaimable_at records when that opens.

BEGIN;

ALTER TABLE subscription_balances
  DROP CONSTRAINT IF EXISTS subscription_balances_status_check;
ALTER TABLE subscription_balances
  ADD CONSTRAINT subscription_balances_status_check
  CHECK (status IN ('pending', 'claimed', 'contributor_reclaimed', 'cancellation_requested', 'closed'));

ALTER TABLE subscription_balances
  ADD COLUMN IF NOT EXISTS closed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closure_reason TEXT,
  ADD COLUMN IF NOT EXISTS reclaimable_at TIMESTAMPTZ;

ALTER TABLE subscription_balances
  DROP CONSTRAINT IF EXISTS subscription_balances_closure_check;
ALTER TABLE subscription_balances
  ADD CONSTRAINT subscription_balances_closure_check
  CHECK (status <> 'closed' OR (closed_at IS NOT NULL AND closure_reason IS NOT NULL));

ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('active', 'cancelled', 'completed', 'closed'));

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS closure_reason TEXT,
  ADD COLUMN IF NOT EXISTS closed_at      TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS subscription_balances_closed_idx
  ON subscription_balances (subscription_id)
  WHERE status = 'closed';

COMMIT;
