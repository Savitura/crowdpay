-- Multi-channel notification system (issue #429)
-- Adds per-user channel destinations + quiet hours, per-event-type channel
-- preferences, and a queue used to batch non-critical notifications that
-- arrive during a user's quiet hours.
--
-- Partitioning (issue: Partition high-volume notification delivery queues by channel)
-- notification_queue is range-free but list-partitioned by channel so that each
-- delivery channel's backlog is stored, indexed, vacuumed, and drained
-- independently. A high-volume channel (e.g. push) cannot bloat or lock the
-- partitions used by lower-volume channels (e.g. sms).
--
-- Migration note: the previous unpartitioned notification_queue table is
-- replaced. Any existing rows are carried over by the INSERT ... SELECT block
-- at the bottom of this file. Application code continues to INSERT/SELECT
-- against the parent table name `notification_queue`; Postgres routes rows to
-- the correct partition automatically, so no API or UI change is required.

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
-- once the window closes. List-partitioned by channel.
--
-- The primary key must include the partition key (channel) in Postgres.
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
  PRIMARY KEY (channel, id)
) PARTITION BY LIST (channel);

-- One partition per delivery channel.
CREATE TABLE IF NOT EXISTS notification_queue_in_app PARTITION OF notification_queue
  FOR VALUES IN ('in_app');
CREATE TABLE IF NOT EXISTS notification_queue_push PARTITION OF notification_queue
  FOR VALUES IN ('push');
CREATE TABLE IF NOT EXISTS notification_queue_slack PARTITION OF notification_queue
  FOR VALUES IN ('slack');
CREATE TABLE IF NOT EXISTS notification_queue_discord PARTITION OF notification_queue
  FOR VALUES IN ('discord');
CREATE TABLE IF NOT EXISTS notification_queue_sms PARTITION OF notification_queue
  FOR VALUES IN ('sms');

-- Pending-work index, created per partition so each channel's drain query
-- scans only its own partition. Indexes on the partitioned parent are
-- propagated automatically to every partition, including future ones.
CREATE INDEX IF NOT EXISTS notification_queue_pending_idx
  ON notification_queue (user_id, channel)
  WHERE flushed_at IS NULL;

-- Carry over any rows from the pre-partitioning table, if one exists in the
-- legacy shape. Rows with an unknown channel are skipped rather than failing
-- the migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'notification_queue'
      AND column_name = 'id'
      AND table_schema = current_schema()
      AND NOT EXISTS (
        SELECT 1 FROM pg_partitioned_table pt
        JOIN pg_class c ON c.oid = pt.partrelid
        WHERE c.relname = 'notification_queue'
      )
  ) THEN
    ALTER TABLE notification_queue RENAME TO notification_queue_legacy;
    INSERT INTO notification_queue (id, user_id, channel, type, title, body, link, created_at, flushed_at)
      SELECT id, user_id, channel, type, title, body, link, created_at, flushed_at
      FROM notification_queue_legacy
      WHERE channel IN ('in_app', 'push', 'slack', 'discord', 'sms');
    DROP TABLE notification_queue_legacy;
  END IF;
END $$;
