-- Migration: Add encrypted wallet secrets to campaigns table
-- This allows secure storage and recovery of campaign wallet private keys

ALTER TABLE campaigns
ADD COLUMN wallet_secret_encrypted TEXT;

-- Add index for wallet lookups
CREATE INDEX idx_campaigns_wallet_public_key ON campaigns(wallet_public_key);
