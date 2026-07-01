CREATE TABLE email_digest_deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category          TEXT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  window_ended_at   TIMESTAMPTZ NOT NULL,
  campaign_count    INTEGER NOT NULL DEFAULT 0,
  item_count        INTEGER NOT NULL DEFAULT 0,
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_digest_deliveries_window_check
    CHECK (window_ended_at > window_started_at),
  CONSTRAINT email_digest_deliveries_unique_window
    UNIQUE (user_id, category, window_ended_at)
);

CREATE INDEX email_digest_deliveries_user_category_sent_idx
  ON email_digest_deliveries (user_id, category, sent_at DESC);
