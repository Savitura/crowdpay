-- Add Soroban contract ID fields to campaigns
ALTER TABLE campaigns ADD COLUMN escrow_contract_id TEXT;
ALTER TABLE campaigns ADD COLUMN milestones_contract_id TEXT;

-- Add contract fields to milestones table if needed (to store on-chain status/index)
ALTER TABLE milestones ADD COLUMN contract_index INTEGER;
