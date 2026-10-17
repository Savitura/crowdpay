-- Contributor-controlled public attribution (issue #944).
--
-- `contributions.sender_public_key` always stores the private wallet record so
-- creators, compliance exports and aggregate metrics keep working. The new
-- `attribution_mode` column only controls what public views are allowed to
-- serialize:
--
--   public       -> wallet key and chosen display name
--   display_name -> chosen display name only (wallet key hidden)
--   anonymous    -> no display name and no wallet key
--
-- Rows created before this migration default to `public`, preserving the
-- existing behaviour for historical contributions.

ALTER TABLE contributions
  ADD COLUMN IF NOT EXISTS attribution_mode VARCHAR(16) NOT NULL DEFAULT 'public';

ALTER TABLE contributions
  DROP CONSTRAINT IF EXISTS contributions_attribution_mode_check;

ALTER TABLE contributions
  ADD CONSTRAINT contributions_attribution_mode_check
  CHECK (attribution_mode IN ('public', 'display_name', 'anonymous'));
