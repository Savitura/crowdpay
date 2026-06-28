-- Add category column to campaigns
ALTER TABLE campaigns ADD COLUMN category TEXT;

-- Create GIN index for full-text search on title and description
CREATE INDEX campaigns_search_idx ON campaigns USING GIN (
  to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, ''))
);
