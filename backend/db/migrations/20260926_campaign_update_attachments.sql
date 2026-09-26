ALTER TABLE campaign_updates
ADD COLUMN attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
