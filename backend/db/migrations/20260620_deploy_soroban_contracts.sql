-- Add platform fee BPS tracking to campaigns for Soroban contract integration
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS platform_fee_bps INTEGER NOT NULL DEFAULT 0;

-- Add contract deployment tracking
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS contract_deployed_at TIMESTAMPTZ;

-- Add refund status tracking on contributions for on-chain refunds
ALTER TABLE contributions
  ADD COLUMN IF NOT EXISTS contract_refund_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS contract_refunded_at TIMESTAMPTZ;

-- Track when a campaign escrow was funded on-chain
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS escrow_funded_at TIMESTAMPTZ;

-- Allow withdrawals to reference milestone status from contract
ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS contract_milestone_index INTEGER;
