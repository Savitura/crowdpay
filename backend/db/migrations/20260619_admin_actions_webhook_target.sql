-- Allow admin_actions to log webhook delivery retries (admin dashboard tooling)

ALTER TABLE admin_actions DROP CONSTRAINT IF EXISTS admin_actions_target_type_check;
ALTER TABLE admin_actions ADD CONSTRAINT admin_actions_target_type_check
  CHECK (target_type IN ('campaign', 'user', 'webhook_delivery'));
