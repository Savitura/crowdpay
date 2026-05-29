-- Add wallet_type to users and allow wallet_secret_encrypted to be nullable

ALTER TABLE users
  ALTER COLUMN wallet_secret_encrypted DROP NOT NULL;

ALTER TABLE users
  ADD COLUMN wallet_type TEXT NOT NULL DEFAULT 'custodial'
    CHECK (wallet_type IN ('custodial', 'freighter'));

-- Set existing rows to custodial explicitly (no-op if default applied)
UPDATE users SET wallet_type = 'custodial' WHERE wallet_type IS NULL;
