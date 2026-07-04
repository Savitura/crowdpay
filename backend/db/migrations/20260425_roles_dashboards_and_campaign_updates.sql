ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'contributor'
  CHECK (role IN ('contributor', 'creator', 'admin'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'is_admin'
  ) THEN
    UPDATE users SET role = 'admin' WHERE is_admin = TRUE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS campaign_updates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  author_id       UUID NOT NULL REFERENCES users(id),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS campaign_updates_campaign_idx
  ON campaign_updates (campaign_id, created_at DESC);
