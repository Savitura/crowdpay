-- Issue #175: Add campaign categories for tag-based filtering
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS category TEXT
  CHECK (category IN (
    'technology', 'community', 'arts', 'education',
    'environment', 'health', 'business', 'open_source', 'other'
  ));

CREATE INDEX IF NOT EXISTS campaigns_category_idx ON campaigns (category);
