-- Campaign Translations: Add locale and milestone_titles support (#753)
ALTER TABLE campaign_translations
  ADD COLUMN IF NOT EXISTS locale TEXT,
  ADD COLUMN IF NOT EXISTS milestone_titles JSONB DEFAULT '[]'::jsonb;

-- Populate locale from language for any pre-existing rows
UPDATE campaign_translations
SET locale = language
WHERE locale IS NULL;

-- Index for fast lookup by (campaign_id, locale)
CREATE INDEX IF NOT EXISTS idx_campaign_translations_campaign_locale
  ON campaign_translations (campaign_id, locale);
