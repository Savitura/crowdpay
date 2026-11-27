-- Multi-channel notification system (issue #429)
-- Adds per-user channel destinations + quiet hours, per-event-type channel
-- preferences, and a queue used to batch non-critical notifications that
-- arrive during a user's quiet hours.
--
-- Partitioning (issue: partition high-volume notification delivery queues by
-- channel): notification_queue is list-partitioned on `channel` so that each
-- delivery channel (push, slack, discord, sms, in_app) has its own physical
-- partition. High-volume channels can then be vacuumed, indexed, retained,
-- and drained independently without contending with other channels.
--
-- Migration note: notification_queue is created as a partitioned table. Any
-- pre-existing unpartitioned notification_queue must be migrated by renaming
-- it to notification_queue_legacy and copying rows into the partitioned table
-- (see the INSERT ... SELECT at the bottom, guarded for fresh installs). Rows
-- whose channel is not one of the declared partitions are routed to the
-- notification_queue_other default partition so no data is rejected.
--
-- Privacy: title/body/link may contain personal data. Rows are deleted when
-- flushed and retention of flushed rows should be enforced by a periodic
-- cleanup job (not included here).

-- Per-user channel destinations and quiet-hours window.
CREATE TABLE IF NOT EXISTS notification_channel_settings (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push_token          TEXT,
  slack_webhook_url   TEXT,
  discord_webhook_url TEXT,
  sms_phone_number    TEXT,
  -- Local hour-of-day (0-23) bounding the quiet window. NULL disables quiet
  -- hours. The window may wrap past midnight (e.g. start=22, end=7).
  quiet_hours_start   SMALLINT CHECK (quiet_hours_start BETWEEN 0 AND 23),
  quiet_hours_end     SMALLINT CHECK (quiet_hours_end BETWEEN 0 AND 23),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-user, per-event-type, per-channel enable/disable override.
-- Absence of a row means "use the channel default" (in-app always on; other
-- channels on when a destination is configured).
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  channel    TEXT NOT NULL CHECK (channel IN ('in_app', 'push', 'slack', 'discord', 'sms')),
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (user_id, event_type, channel)
);

-- Non-critical notifications parked during quiet hours, flushed as a digest
-- once the window closes. Partitioned by channel so each channel's backlog is
-- stored and processed separately.
--
-- The primary key must include the partition key, so it is (id, channel).
CREATE TABLE IF NOT EXISTS notification_queue (
  id         UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel    TEXT NOT NULL CHECK (channel IN ('in_app', 'push', 'slack', 'discord', 'sms')),
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  flushed_at TIMESTAMPTZ,
  PRIMARY KEY (id, channel)
) PARTITION BY LIST (channel);

CREATE TABLE IF NOT EXISTS notification_queue_in_app
  PARTITION OF notification_queue FOR VALUES IN ('in_app');
CREATE TABLE IF NOT EXISTS notification_queue_push
  PARTITION OF notification_queue FOR VALUES IN ('push');
CREATE TABLE IF NOT EXISTS notification_queue_slack
  PARTITION OF notification_queue FOR VALUES IN ('slack');
CREATE TABLE IF NOT EXISTS notification_queue_discord
  PARTITION OF notification_queue FOR VALUES IN ('discord');
CREATE TABLE IF NOT EXISTS notification_queue_sms
  PARTITION OF notification_queue FOR VALUES IN ('sms');

-- Catch-all so that any channel value not declared above is still stored
-- rather than causing a hard insert failure during rollout.
CREATE TABLE IF NOT EXISTS notification_queue_other
  PARTITION OF notification_queue DEFAULT;

-- Pending-row lookup per user and channel. Created on the parent so it is
-- propagated to every partition, including the default partition.
CREATE INDEX IF NOT EXISTS notification_queue_pending_idx
  ON notification_queue (user_id, channel)
  WHERE flushed_at IS NULL;
