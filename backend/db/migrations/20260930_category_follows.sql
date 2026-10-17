-- Issue #957: follow campaign categories and receive a digest.
--
-- Backward-compatible: additive only (new table + nullable-compatible column
-- with a TRUE default so existing preference rows keep receiving digests).
-- Re-runnable guards (IF NOT EXISTS) keep `migrate:fresh --bootstrap-schema`
-- convergent with db/schema.sql, which declares the same objects.

CREATE TABLE IF NOT EXISTS category_follows (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    TEXT NOT NULL CHECK (category IN (
                'technology', 'community', 'arts', 'education',
                'environment', 'health', 'business', 'open_source', 'other'
              )),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, category)
);

CREATE INDEX IF NOT EXISTS category_follows_category_idx
  ON category_follows (category);
CREATE INDEX IF NOT EXISTS category_follows_user_idx
  ON category_follows (user_id);

-- Master switch for the category section of the weekly digest. TRUE preserves
-- existing behaviour for users who never open notification settings.
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS category_digest BOOLEAN NOT NULL DEFAULT TRUE;
