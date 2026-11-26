-- Migration: 20261124_ledger_stream_cursors_state_check.sql
-- Aligns migrations-only databases with db/schema.sql (#1270).
--
-- schema.sql declares ledger_stream_cursors.state with
-- CHECK (state IN ('running', 'paused', 'error')) inline, but the table is
-- created from 20261016_ledger_stream_cursors.sql and the column is added by
-- 20261020_reliability_workflows.sql without that domain. A database built
-- from migrations alone therefore accepted arbitrary state values while a
-- schema.sql bootstrap rejected them.
--
-- Guarded so the schema.sql bootstrap path (which already has the constraint
-- inline) stays a no-op instead of failing with duplicate_object.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'ledger_stream_cursors_state_check'
       AND conrelid = 'ledger_stream_cursors'::regclass
  ) THEN
    ALTER TABLE ledger_stream_cursors
      ADD CONSTRAINT ledger_stream_cursors_state_check
      CHECK (state IN ('running', 'paused', 'error'));
  END IF;
END $$;
