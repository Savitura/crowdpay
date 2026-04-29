DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'kyc_status') THEN
    CREATE TYPE kyc_status AS ENUM ('unverified', 'pending', 'verified', 'rejected');
  END IF;
END $$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS kyc_status kyc_status NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS kyc_provider_reference TEXT,
  ADD COLUMN IF NOT EXISTS kyc_completed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS users_kyc_provider_reference_idx
  ON users (kyc_provider_reference)
  WHERE kyc_provider_reference IS NOT NULL;
