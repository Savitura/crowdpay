-- Supporting index for the withdrawal velocity limit (#1126).
-- The limiter counts an actor's recent requests by requested_by + created_at.
CREATE INDEX IF NOT EXISTS withdrawal_requests_requested_by_created_idx
  ON withdrawal_requests (requested_by, created_at DESC);
