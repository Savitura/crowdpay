-- Admin audit-log viewer (#audit)
-- Normalized append-only audit log for security- and money-related actions.
-- No UPDATE/DELETE privileges are exposed (append-only) to preserve integrity.
CREATE TABLE IF NOT EXISTS audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT,
  ip_address    TEXT,
  user_agent    TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action);
CREATE INDEX IF NOT EXISTS audit_logs_resource_idx ON audit_logs (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs (created_at DESC);

-- Append-only marker: blocking UPDATE/DELETE on the table keeps it tamper-evident
-- at the application layer (the dedicated insert role is the only writer).
REVOKE UPDATE, DELETE ON TABLE audit_logs FROM PUBLIC;
REVOKE TRUNCATE ON TABLE audit_logs FROM PUBLIC;
