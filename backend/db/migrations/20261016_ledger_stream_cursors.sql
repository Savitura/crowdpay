-- Migration: 20261016_ledger_stream_cursors.sql
-- Supports: resumable Horizon ledgers streams per campaign wallet
--
-- The table was defined only in db/schema.sql, so a database bootstrapped from
-- migrations never had it and every cursor read/writes failed (db/schema.sql
-- and the migration set are verified to converge by
-- db/verify-schema-convergence.js).
--
-- campaign_id is the primary key because one stream cursor is tracked per
-- campaign; the upsert in ledgerMonitor.saveCursor and
-- horizonIngestionWorker relies on ON CONFLICT (campaign_id).
--
-- last_cursor holds the Horizon paging token (an opaque, monotonically
-- increasing string), not a number, so it is TEXT. wallet_public_key is
-- denormalised from campaigns so the monitoring views can report the live
-- stream for a wallet without joining back through campaigns.

CREATE TABLE IF NOT EXISTS ledger_stream_cursors (
  campaign_id       UUID PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  wallet_public_key TEXT NOT NULL,
  last_cursor       TEXT NOT NULL,
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Serves the "which wallet is at which cursor" readout in the ops runbooks.
CREATE INDEX IF NOT EXISTS ledger_stream_cursors_wallet_idx
  ON ledger_stream_cursors (wallet_public_key);
