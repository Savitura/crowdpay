-- Durable idempotency guard for creator withdrawal requests (#1098).
--
-- The HTTP-level `idempotency_keys` record written by the idempotency
-- middleware expires after 24 hours. Persisting the key on the withdrawal row
-- keeps the guarantee for longer than that: a retry that arrives after the
-- HTTP record expired (or after it was pruned by the retention job) resolves
-- to the withdrawal that was already created instead of opening a second one.
--
-- The unique index is scoped to (actor, key) so two creators may use the same
-- key value without colliding, matching the actor scoping of `idempotency_keys`.

ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS idempotency_actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS withdrawal_requests_actor_idempotency_idx
  ON withdrawal_requests (idempotency_actor_id, idempotency_key)
  WHERE idempotency_actor_id IS NOT NULL AND idempotency_key IS NOT NULL;
