-- Add secret_hint to webhooks
ALTER TABLE webhooks ADD COLUMN secret_hint TEXT;

-- Populate existing hints
UPDATE webhooks
SET secret_hint = CONCAT(LEFT(secret, 10), '…', RIGHT(secret, 4))
WHERE secret NOT LIKE 'cpi:v1:%';
