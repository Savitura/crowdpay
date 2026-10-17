-- Sponsor-funded contribution matching campaigns (#948).
--
-- The application already rejected a second *active* pledge from the same
-- sponsor for the same campaign, but that check was a read-then-insert and
-- therefore racy: two concurrent requests could both pass it. This migration
-- makes the invariant enforceable by the database so duplicate pledges have a
-- single, deterministic outcome regardless of concurrency.

-- Repair any row that already overshot its pledge (possible under the previous
-- non-locking matching path) before the constraint is installed.
UPDATE campaign_matches
   SET matched_amount = pledge_amount,
       status = CASE WHEN status = 'active' THEN 'exhausted' ELSE status END,
       updated_at = NOW()
 WHERE matched_amount > pledge_amount;

-- A sponsor may hold at most one *active* pledge per campaign. Completed and
-- exhausted pledges are exempt so a sponsor can pledge again after a pool is
-- consumed or closed.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_matches_active_sponsor_idx
  ON campaign_matches (campaign_id, sponsor_user_id)
  WHERE status = 'active';

-- Matching can never exceed the pledged pool. NOT VALID keeps the migration
-- backward compatible with rows written before the invariant existed while
-- still enforcing it for every new write.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'campaign_matches_matched_within_pledge'
       AND conrelid = 'campaign_matches'::regclass
  ) THEN
    ALTER TABLE campaign_matches
      ADD CONSTRAINT campaign_matches_matched_within_pledge
      CHECK (matched_amount <= pledge_amount) NOT VALID;
  END IF;
END $$;
