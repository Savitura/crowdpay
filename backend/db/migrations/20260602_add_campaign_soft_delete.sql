-- Add soft delete support for campaigns
ALTER TABLE campaigns ADD COLUMN deleted_at TIMESTAMPTZ;
CREATE INDEX ON campaigns (deleted_at) WHERE deleted_at IS NULL;
