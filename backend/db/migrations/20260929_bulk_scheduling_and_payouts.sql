-- Migration: 20260929_bulk_scheduling_and_payouts.sql
-- Supports:
-- 1. Bounded bulk thank-you fan-out and delivery progress tracking (#914)
-- 2. Campaign update scheduling for future publication (#922)
-- 3. Recurring creator payout schedules with two-approver withdrawal flow (#926)
-- 4. Bulk campaign creation from CSV with per-row validation report (#927)

-- 1. Thank You Messages Progress & Metrics (#914)
ALTER TABLE thank_you_messages
  ADD COLUMN IF NOT EXISTS total_recipients INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sent_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'completed';

-- 2. Campaign Updates Scheduling (#922)
ALTER TABLE campaign_updates
  ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'published';

CREATE INDEX IF NOT EXISTS idx_campaign_updates_scheduled
  ON campaign_updates (scheduled_for)
  WHERE status = 'scheduled';

-- 3. Recurring Payout Schedules & Execution Runs (#926)
CREATE TABLE IF NOT EXISTS recurring_payout_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(18, 7),
  percentage NUMERIC(5, 2),
  asset_type VARCHAR(12) NOT NULL,
  destination_key VARCHAR(56) NOT NULL,
  cadence VARCHAR(20) NOT NULL CHECK (cadence IN ('daily', 'weekly', 'biweekly', 'monthly')),
  start_date TIMESTAMPTZ NOT NULL,
  next_run_at TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ,
  max_occurrences INTEGER,
  occurrences_count INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
  last_run_at TIMESTAMPTZ,
  last_withdrawal_request_id UUID REFERENCES withdrawal_requests(id) ON DELETE SET NULL,
  last_error TEXT,
  evidence JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_schedules_next_run
  ON recurring_payout_schedules (next_run_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_payout_schedules_campaign_id
  ON recurring_payout_schedules (campaign_id);

CREATE TABLE IF NOT EXISTS recurring_payout_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL REFERENCES recurring_payout_schedules(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  withdrawal_request_id UUID REFERENCES withdrawal_requests(id) ON DELETE SET NULL,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(20) NOT NULL CHECK (status IN ('success', 'insufficient_funds', 'failed', 'skipped_paused')),
  amount NUMERIC(18, 7),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_runs_schedule_id
  ON recurring_payout_runs (schedule_id);

-- 4. Bulk Campaign Import Jobs (#927)
CREATE TABLE IF NOT EXISTS bulk_campaign_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT UNIQUE,
  content_hash TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  successful_rows INTEGER NOT NULL DEFAULT 0,
  failed_rows INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'validating', 'processing', 'completed', 'failed')),
  validation_report JSONB DEFAULT '[]'::jsonb,
  results JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bulk_imports_user_id
  ON bulk_campaign_imports (user_id);
