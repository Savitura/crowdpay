ALTER TABLE campaigns
  ADD COLUMN featured        BOOLEAN DEFAULT FALSE,
  ADD COLUMN featured_at     TIMESTAMPTZ,
  ADD COLUMN featured_note   TEXT;

CREATE INDEX ON campaigns (featured) WHERE featured = TRUE;
