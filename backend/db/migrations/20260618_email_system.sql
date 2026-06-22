-- Idempotency log for transactional emails: one row per logical send event.
CREATE TABLE sent_emails (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key      TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sent_emails_dedupe_key_unique UNIQUE (dedupe_key)
);

CREATE INDEX sent_emails_created_at_idx ON sent_emails (created_at DESC);

-- Per-category unsubscribe state for non-transactional emails (e.g. campaign updates).
CREATE TABLE email_unsubscribes (
  email           TEXT NOT NULL,
  category        TEXT NOT NULL,
  unsubscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (email, category)
);
