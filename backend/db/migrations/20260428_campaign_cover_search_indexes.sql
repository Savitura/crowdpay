ALTER TABLE campaigns ADD COLUMN cover_image_url TEXT;

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns (status);
CREATE INDEX IF NOT EXISTS idx_campaigns_asset_type ON campaigns (asset_type);
CREATE INDEX IF NOT EXISTS idx_campaigns_created_at ON campaigns (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaigns_deadline ON campaigns (deadline);
CREATE INDEX IF NOT EXISTS idx_campaigns_search ON campaigns USING GIN (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, '')));
