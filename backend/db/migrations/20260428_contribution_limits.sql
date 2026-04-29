-- Issue 64: Minimum and maximum contribution limits per campaign
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS min_contribution NUMERIC(20, 7);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS max_contribution NUMERIC(20, 7);
