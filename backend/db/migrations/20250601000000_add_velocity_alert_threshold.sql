-- Campaign velocity alert threshold.
--
-- This migration is dated 2025-06-01, which sorts *before* the base schema
-- migration (20260401_users_campaigns_contributions.sql) that creates
-- `campaigns`. On a migrations-only install the ALTER therefore had nothing to
-- attach to and aborted the whole run. 20261003_add_velocity_alert_threshold.sql
-- re-applies the same idempotent ALTER after the base table exists, so the
-- guard below keeps this legacy entry a safe no-op instead of a hard failure.
--
-- Already-applied databases recorded this filename long before the guard
-- existed; the statement is `IF NOT EXISTS` either way, so their schema is
-- unchanged.
DO $$
BEGIN
  IF to_regclass('public.campaigns') IS NOT NULL THEN
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS velocity_alert_threshold NUMERIC(18, 7) DEFAULT 0;
  END IF;
END $$;
