-- Migration: 20261003_add_velocity_alert_threshold.sql
-- Unblocks the migrations-only install path broken by
-- 20250601000000_add_velocity_alert_threshold.sql, which sorts before the base
-- schema migration and therefore ran before `campaigns` existed.
--
-- The original ALTER was wrapped in a table-existence guard so the run would
-- not abort; this re-applies the same idempotent statement once the base table
-- is guaranteed to exist. Databases that already ran the original migration
-- (or that bootstrap from db/schema.sql, which defines the column) see no
-- change because of `IF NOT EXISTS`.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS velocity_alert_threshold NUMERIC(18, 7) DEFAULT 0;
