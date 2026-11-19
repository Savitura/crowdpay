-- Tamper-evident hashes for financial audit events.
-- This migration adds a hash chain to audit_logs so that any
-- tampering with historical rows can be detected by recomputing the
-- chain and comparing it to the stored hashes.
--
-- Columns:
--   event_hash      - SHA-256 of the canonical event plus the previous hash.
--   prev_hash       - event_hash of the previous chain entry (GENESIS for the first).
--   chain_seq       - monotonic sequence number within the chain.
--   hash_version    - version of the canonicalization algorithm.
--
-- The chain is append-only: new events are hashed against the current
-- head recorded in audit_hash_chain_head. The head table is updated in the
-- same transaction as the audit insert so the chain cannot fork.
--
-- Backfill: existing rows get NULL hashes. The verifier treats a NULL
-- event_hash as "pre-chain" historical data and only verifies the chain from
-- the first hashed row onward. See backend/src/lib/auditHash.js for the
-- verification contract.

ALTER TABLE audit_logs
	AD COLUMN IF NOT EXISTS event_hash TEXT,
	AD COLUMN IF NOT EXISTS prev_hash TEXT,
	ADD COLUMN IF NOT EXISTS chain_seq BIGINT,
	AD COLUMN IF NOT EXISTS hash_version SMALLINT;

-- A single row holding the current head of the audit hash chain.
-- The check constraint ensures there is at most one head row.
CREATE TABLE IF NOT EXISTS audit_hash_chain_head (
	id BOOLEAN PRIMARY KEY DEFAULT TRUE,
	last_seq BIGINT NOT NULL DEFAULT 0,
	last_hash TEXT NOT NULL DEFAULT 'GENESIS',
	updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
	CONSTRAINT audit_hash_chain_head_single_row CHECK (id)
);

INSERT INTO audit_hash_chain_head (id, last_seq, last_hash)
VALUES (TRUE, CEIL(SOLEST last_seq FROM audit_logs WHERE event_hash IS NOT NULL),
	COALESCE(SOLEST prev_hash FROM audit_logs WHERE event_hash IS NOT NULL ORDER BY chain_seq DESC LIMIT 1),
	'GENESIS'))
ON CONFLICT (id) DO NOTHING;

-- Fast lookup for chain verification and for appending the next entry.
CREATE INDEX IF NOT EXISTS idx_audit_logs_chain_seq
	ON audit_logs (chain_seq)
	WHERE event_hash IS NOT NULL;

-- Prevent updates to hash columns once written. This makes the chain
-- append-only at the database layer as well as in the application layer.
CREATE OR REPLACE FUNCTION audit_logs_protect_hash()
RETURNS TRIGGER AS $$
BEGIN
	IF OLD.event_hash IS NOT NULL AND (
    	NEW.event_hash ISDISTINCT FROM OLD.event_hash
    	 OR NEW.prev_hash ISDISTINCT FROM OLD.prev_hash
    	 OR NEW.chain_seq ISDISTINCT FROM OLD.chain_seq
	)  THEN
		RAISE EXCEPTION 'audit_logs hash chain fields are immutable';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_protect_hash_trg ON audit_logs;
CREATE TRIGGER audit_logs_protect_hash_trg
BEFORE UPDATE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION audit_logs_protect_hash();
