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
--
-- Delivery queue partitioning (issue: partition high-volume notification
-- delivery queues by channel):
-- Each communication channel above is delivered through its own queue
-- partition so that a backlog on one high-volume channel (e.g. `updates`)
-- cannot starve delivery of another (e.g. `messages`). The partition key is
-- the channel name; the queue row carries `(channel, campaign_id, user_id)`
-- and is claimed per channel. Rows are only enqueued for channels whose
-- per-campaign flag is TRUE, so muted channels never create delivery work.
--
-- Compatibility: this migration is additive. No existing table or column is
-- altered, and the API contract of the preferences endpoints is unchanged.
-- Privacy: rows contain only opaque UUIDs and boolean flags; no personal data.
-- Security: cascading deletes ensure preference rows do not outlive the user
-- or campaign that owns them.

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

-- Per-channel delivery queue. Partitioned by `channel` so each high-volume
-- channel has its own claim/consume path and independent backlog.
CREATE TABLE IF NOT EXISTS notification_delivery_queue (
  id           BIGSERIAL NOT NULL,
  channel      TEXT NOT NULL CHECK (channel IN ('updates', 'milestones', 'funding_updates', 'messages', 'surveys')),
  campaign_id  UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload      JSONB NOT NULL DEFAULT '{}'::JSONB,
  attempts     INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel, id)
) PARTITION BY LIST (channel);

CREATE TABLE IF NOT EXISTS notification_delivery_queue_updates
  PARTITION OF notification_delivery_queue FOR VALUES IN ('updates');
CREATE TABLE IF NOT EXISTS notification_delivery_queue_milestones
  PARTITION OF notification_delivery_queue FOR VALUES IN ('milestones');
CREATE TABLE IF NOT EXISTS notification_delivery_queue_funding_updates
  PARTITION OF notification_delivery_queue FOR VALUES IN ('funding_updates');
CREATE TABLE IF NOT EXISTS notification_delivery_queue_messages
  PARTITION OF notification_delivery_queue FOR VALUES IN ('messages');
CREATE TABLE IF NOT EXISTS notification_delivery_queue_surveys
  PARTITION OF notification_delivery_queue FOR VALUES IN ('surveys');

-- Serves per-channel claim ordering: oldest due work first within a partition.
CREATE INDEX IF NOT EXISTS idx_notification_delivery_queue_due
  ON notification_delivery_queue (channel, available_at, id);
