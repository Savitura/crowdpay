-- Migration: 20261001_campaign_communication_preferences.sql
-- Supports: contributor communication preferences per campaign (#961)
--
-- The account-level `notification_preferences` row is global: a contributor who
-- mutes milestone announcements loses them on every campaign at once. This
-- table stores the per-campaign override that sits *between* the global
-- account switch and the per-follower row in `campaign_followers`:
--
--   global notification_preferences  ->  campaign_communication_preferences  ->  campaign_followers
--   (mute a category everywhere)        (mute a category for one campaign)      (a follower's own opt-ins)
--
-- Every channel defaults to TRUE and an absent row means "no override", so
-- existing contributors keep receiving every communication they get today.
-- The row is deleted again by `DELETE /api/campaigns/:id/communication-preferences`
-- (reset) and cascades away with the campaign or the user.

CREATE TABLE IF NOT EXISTS campaign_communication_preferences (
  campaign_id     UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updates         BOOLEAN NOT NULL DEFAULT TRUE,
  milestones      BOOLEAN NOT NULL DEFAULT TRUE,
  funding_updates BOOLEAN NOT NULL DEFAULT TRUE,
  messages        BOOLEAN NOT NULL DEFAULT TRUE,
  surveys         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, user_id)
);

-- Serves the "which of my campaigns have I muted?" listing in notification
-- settings (newest change first) without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_campaign_communication_preferences_user
  ON campaign_communication_preferences (user_id, updated_at DESC);
