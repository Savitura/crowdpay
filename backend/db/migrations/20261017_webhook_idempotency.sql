CREATE TABLE webhook_events (
  id           BIGSERIAL PRIMARY KEY,
  event_source TEXT        NOT NULL,
  event_id     TEXT        NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(event_source, event_id)
);
