ALTER TABLE campaigns
  ADD COLUMN content_fingerprint TEXT,
  ADD COLUMN is_flagged_duplicate BOOLEAN DEFAULT FALSE;
