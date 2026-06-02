-- Full-text search: weighted tsvector column and GIN index (replaces expression index)
DROP INDEX IF EXISTS idx_campaigns_search;

ALTER TABLE campaigns
ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(description, '')), 'B')
) STORED;

CREATE INDEX campaigns_search_idx ON campaigns USING GIN (search_vector);
