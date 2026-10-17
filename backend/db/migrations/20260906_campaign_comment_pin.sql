-- Add pinned comment support (#755)
ALTER TABLE campaign_comments
  ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX campaign_comments_campaign_pinned_idx
  ON campaign_comments (campaign_id, pinned)
  WHERE pinned = TRUE;
