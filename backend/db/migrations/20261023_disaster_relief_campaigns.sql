-- Migration: 20261023_disaster_relief_campaigns.sql
-- Supports: disaster-relief campaign mode with rapid verification workflow
--
-- Stores the emergency dossier, rapid verification SLA tracking, reviewer
-- decisions, and append-only lifecycle audit trail for disaster-relief
-- campaigns. Exactly one row may exist per campaign (`UNIQUE (campaign_id)`).
--
-- Sensitive fields (`emergency_contact`, `review_note`, `revoked_reason`,
-- `reviewed_by`, `revoked_by`) are restricted to the campaign owner, accepted
-- managers, and platform admins; the public read redacts them and hides
-- unverified records.

CREATE TABLE IF NOT EXISTS campaign_disaster_relief (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id                UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  created_by                 UUID REFERENCES users(id) ON DELETE SET NULL,
  incident_name              TEXT NOT NULL,
  disaster_type              TEXT NOT NULL
                               CHECK (disaster_type IN (
                                 'flood', 'earthquake', 'wildfire', 'hurricane',
                                 'drought', 'conflict', 'epidemic', 'industrial', 'other'
                               )),
  severity_level             TEXT NOT NULL DEFAULT 'urgent'
                               CHECK (severity_level IN ('watch', 'urgent', 'critical', 'catastrophic')),
  affected_region            TEXT NOT NULL,
  affected_population        INT CHECK (affected_population IS NULL OR affected_population > 0),
  responder_organization     TEXT,
  emergency_contact          TEXT,
  verification_badge         TEXT,
  evidence_items             JSONB NOT NULL DEFAULT '[]'::jsonb,
  status                     TEXT NOT NULL DEFAULT 'draft'
                               CHECK (status IN (
                                 'draft', 'pending_review', 'verified',
                                 'changes_requested', 'rejected', 'revoked'
                               )),
  rapid_disbursement_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  submitted_at               TIMESTAMPTZ,
  reviewed_by                UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at                TIMESTAMPTZ,
  review_note                TEXT,
  revoked_by                 UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at                 TIMESTAMPTZ,
  revoked_reason             TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaign_disaster_relief_one_per_campaign UNIQUE (campaign_id),
  CONSTRAINT campaign_disaster_relief_incident_len CHECK (char_length(incident_name) <= 160),
  CONSTRAINT campaign_disaster_relief_region_len CHECK (char_length(affected_region) <= 200),
  CONSTRAINT campaign_disaster_relief_org_len CHECK (responder_organization IS NULL OR char_length(responder_organization) <= 200),
  CONSTRAINT campaign_disaster_relief_contact_len CHECK (emergency_contact IS NULL OR char_length(emergency_contact) <= 200),
  CONSTRAINT campaign_disaster_relief_badge_len CHECK (verification_badge IS NULL OR char_length(verification_badge) <= 120),
  CONSTRAINT campaign_disaster_relief_evidence_array CHECK (jsonb_typeof(evidence_items) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_campaign_disaster_relief_status_submitted
  ON campaign_disaster_relief (status, submitted_at ASC);

CREATE TABLE IF NOT EXISTS campaign_disaster_relief_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id  UUID NOT NULL REFERENCES campaign_disaster_relief(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  note        TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_disaster_relief_events_dossier
  ON campaign_disaster_relief_events (dossier_id, created_at ASC);
