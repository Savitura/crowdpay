ALTER TABLE contributions
  ADD COLUMN IF NOT EXISTS platform_fee_amount NUMERIC(20, 7);
