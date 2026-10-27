-- Create dedicated table for backup codes so consumption is atomic via
-- DELETE ... RETURNING, eliminating the TOCTOU race in the old array-on-users approach.

CREATE TABLE user_backup_codes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX user_backup_codes_user_idx ON user_backup_codes (user_id);

-- Migrate existing hashed codes from the TEXT[] column into the new table.
-- Each element of the array becomes one row.
INSERT INTO user_backup_codes (user_id, code_hash)
SELECT u.id, unnested.hash
FROM   users u,
       LATERAL unnest(u.backup_codes) AS unnested(hash)
WHERE  u.backup_codes IS NOT NULL
  AND  cardinality(u.backup_codes) > 0;

-- Drop the old column (data already copied above).
ALTER TABLE users DROP COLUMN backup_codes;
