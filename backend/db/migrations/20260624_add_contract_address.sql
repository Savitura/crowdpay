-- Primary Soroban contract address for campaign (escrow instance)
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS contract_address TEXT;

-- Backfill from existing escrow contract IDs
UPDATE campaigns
SET contract_address = escrow_contract_id
WHERE contract_address IS NULL AND escrow_contract_id IS NOT NULL;
