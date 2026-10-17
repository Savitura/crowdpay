-- Migration: 20261002_campaign_outcome_surveys.sql
-- Supports: beneficiary outcome surveys after campaign completion (#960)
--
-- A creator closes a campaign, then asks the people who backed it what
-- actually happened. Exactly one survey may exist per campaign, so the
-- duplicate-create path is a deterministic 409 rather than a race.
--
-- `questions` is a JSONB array of `{ id, prompt, type, required, options }`
-- objects; `type` is 'rating' | 'single_choice' | 'text'. The shape is
-- validated in the service (outcomeSurveyService.validateQuestions) and
-- re-validated on every submission so answers can never drift from the
-- published question set.
--
-- Answers are never exposed to non-owners: the public read returns aggregate
-- counts only, and the per-respondent rows stay behind the creator/admin
-- results endpoint.

CREATE TABLE IF NOT EXISTS campaign_outcome_surveys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  intro        TEXT,
  questions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  status       TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'open', 'closed')),
  opens_at     TIMESTAMPTZ,
  closes_at    TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  closed_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaign_outcome_surveys_one_per_campaign UNIQUE (campaign_id),
  CONSTRAINT campaign_outcome_surveys_title_len CHECK (char_length(title) <= 200),
  CONSTRAINT campaign_outcome_surveys_intro_len CHECK (intro IS NULL OR char_length(intro) <= 2000),
  CONSTRAINT campaign_outcome_surveys_questions_array CHECK (jsonb_typeof(questions) = 'array'),
  CONSTRAINT campaign_outcome_surveys_window CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at)
);

-- Serves the "which surveys are open right now?" sweep and the per-campaign
-- status lookup without a sequential scan of the (small) survey table.
CREATE INDEX IF NOT EXISTS idx_campaign_outcome_surveys_status
  ON campaign_outcome_surveys (status, campaign_id);

CREATE TABLE IF NOT EXISTS campaign_outcome_survey_responses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id    UUID NOT NULL REFERENCES campaign_outcome_surveys(id) ON DELETE CASCADE,
  campaign_id  UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers      JSONB NOT NULL DEFAULT '{}'::jsonb,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaign_outcome_survey_responses_unique_respondent UNIQUE (survey_id, user_id),
  CONSTRAINT campaign_outcome_survey_responses_answers_object CHECK (jsonb_typeof(answers) = 'object')
);

-- Response counts per survey for the aggregate results payload, and the
-- "did I already answer?" lookup for the respondent's own view.
CREATE INDEX IF NOT EXISTS idx_campaign_outcome_survey_responses_survey
  ON campaign_outcome_survey_responses (survey_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_outcome_survey_responses_user
  ON campaign_outcome_survey_responses (user_id, campaign_id);

CREATE TABLE IF NOT EXISTS campaign_outcome_survey_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id  UUID NOT NULL REFERENCES campaign_outcome_surveys(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  actor_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_outcome_survey_events_survey
  ON campaign_outcome_survey_events (survey_id, created_at);
