-- Add admin moderation support

-- Add soft-delete timestamp to campaigns
ALTER TABLE campaigns
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Add ban status to users
ALTER TABLE users
ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE;

-- Create admin_actions audit table
CREATE TABLE IF NOT EXISTS admin_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id   UUID NOT NULL REFERENCES users(id),
  action_type     TEXT NOT NULL,
  target_type     TEXT NOT NULL CHECK (target_type IN ('campaign', 'user')),
  target_id       UUID NOT NULL,
  details         JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_actions_admin_user_idx ON admin_actions (admin_user_id);
CREATE INDEX IF NOT EXISTS admin_actions_target_idx ON admin_actions (target_type, target_id);
CREATE INDEX IF NOT EXISTS admin_actions_created_at_idx ON admin_actions (created_at DESC);

-- Add status for campaign suspension (optional: if we want to track suspension separately)
-- The status field already exists, but we can suspend by setting status = 'suspended'
-- However, let's ensure status enum includes 'suspended' if it doesn't already
-- First check if we need to extend the status check constraint
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_status_check 
  CHECK (status IN ('active', 'funded', 'in_progress', 'completed', 'closed', 'withdrawn', 'failed', 'suspended'));
