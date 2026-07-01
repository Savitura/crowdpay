-- User session management (Issue #435)
--
-- Tracks active sessions for users with device fingerprint, IP, and user agent.
-- Enables session listing, revocation, and anomaly detection.

CREATE TABLE user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_id UUID NOT NULL REFERENCES refresh_tokens(id) ON DELETE CASCADE,
  device_fingerprint TEXT,
  ip_address INET,
  user_agent TEXT,
  location_country TEXT,
  location_city TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT user_sessions_refresh_token_unique UNIQUE (refresh_token_id)
);

CREATE INDEX user_sessions_user_active_idx ON user_sessions (user_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);
CREATE INDEX user_sessions_fingerprint_idx ON user_sessions (device_fingerprint) WHERE device_fingerprint IS NOT NULL;
CREATE INDEX user_sessions_ip_idx ON user_sessions (ip_address) WHERE ip_address IS NOT NULL;

-- Login attempt monitoring for anomaly detection
CREATE TABLE login_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  ip_address INET,
  user_agent TEXT,
  device_fingerprint TEXT,
  success BOOLEAN NOT NULL DEFAULT FALSE,
  failure_reason TEXT,
  location_country TEXT,
  location_city TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX login_attempts_user_idx ON login_attempts (user_id, created_at DESC);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip_address, created_at DESC);
CREATE INDEX login_attempts_email_idx ON login_attempts (email, created_at DESC);
CREATE INDEX login_attempts_created_idx ON login_attempts (created_at DESC);

-- Alert on suspicious login activity
CREATE TABLE login_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('new_device', 'new_location', 'suspicious_ip', 'multiple_failures')),
  ip_address INET,
  device_fingerprint TEXT,
  location_country TEXT,
  location_city TEXT,
  details JSONB,
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX login_alerts_user_idx ON login_alerts (user_id, created_at DESC);
CREATE INDEX login_alerts_acknowledged_idx ON login_alerts (acknowledged) WHERE acknowledged = FALSE;