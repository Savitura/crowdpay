-- Add is_hidden column to campaigns table for soft-hide functionality
ALTER TABLE campaigns
  ADD COLUMN is_hidden BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for efficient filtering of hidden campaigns in public listings
CREATE INDEX idx_campaigns_is_hidden ON campaigns (is_hidden) WHERE is_hidden = TRUE;
