-- Replace the multi-channel notification_preferences table (created in
-- 20260716_multi_channel_notifications.sql) with a simpler per-user
-- preference row that the public notification settings UI writes to.
-- The old schema stored per-event-type, per-channel overrides and is no
-- longer used.

DROP TABLE IF EXISTS notification_preferences;

CREATE TABLE notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  campaign_updates BOOLEAN NOT NULL DEFAULT TRUE,
  refunds BOOLEAN NOT NULL DEFAULT TRUE,
  disputes BOOLEAN NOT NULL DEFAULT TRUE,
  milestones BOOLEAN NOT NULL DEFAULT TRUE,
  marketing BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
