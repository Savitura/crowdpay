-- Funds released notifications (#590)
-- Allow users to opt in/out of email preferences for release transparency
-- events. In-app delivery remains the baseline notification channel.
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  -- The later centralized email-preferences migration intentionally removes
  -- the per-channel column. Keep this historical migration convergent when a
  -- fresh schema.sql is bootstrapped before migrations are replayed.
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'notification_preferences'
      AND column_name = 'channel'
  ) THEN
    SELECT conname INTO constraint_name
    FROM pg_constraint
    WHERE conrelid = 'notification_preferences'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%channel%';

    IF constraint_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE notification_preferences DROP CONSTRAINT %I', constraint_name);
    END IF;

    ALTER TABLE notification_preferences
      ADD CONSTRAINT notification_preferences_channel_check
      CHECK (channel IN ('in_app', 'email', 'push', 'slack', 'discord', 'sms'));
  END IF;
END $$;
