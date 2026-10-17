-- Migration: 20260929_milestone_evidence_checklists.sql
-- Supports: structured milestone evidence checklists (#949)
--
-- A milestone can define a checklist of evidence items that the creator
-- completes when submitting work. Each completed item snapshots its label
-- and detail so reviewer-facing history stays stable even if the template
-- is later edited.

CREATE TABLE IF NOT EXISTS milestone_evidence_checklist_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id  UUID NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  detail        TEXT,
  required      BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT milestone_evidence_checklist_items_label_len
    CHECK (char_length(label) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_milestone_checklist_items
  ON milestone_evidence_checklist_items (milestone_id, display_order);

CREATE TABLE IF NOT EXISTS milestone_evidence_checklist_completions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       UUID NOT NULL REFERENCES milestone_evidence_checklist_items(id) ON DELETE CASCADE,
  milestone_id  UUID NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  completed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  label_snapshot TEXT NOT NULL,
  detail_snapshot TEXT,
  completed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT milestone_evidence_checklist_completions_unique
    UNIQUE (item_id)
);

CREATE INDEX IF NOT EXISTS idx_milestone_checklist_completions
  ON milestone_evidence_checklist_completions (milestone_id);
