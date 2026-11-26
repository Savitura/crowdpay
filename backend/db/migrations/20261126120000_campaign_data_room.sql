-- Migration: Campaign Data Room with Role-Based Access Control (#1109)
-- Creates tables for storing data room files/attachments and recording audit/access logs.

CREATE TABLE IF NOT EXISTS campaign_data_room_files (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  uploaded_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  file_url          TEXT NOT NULL,
  file_size         BIGINT NOT NULL DEFAULT 0,
  mime_type         TEXT NOT NULL,
  file_hash         TEXT,
  category          TEXT NOT NULL DEFAULT 'other'
                    CHECK (category IN ('pitch_deck', 'financials', 'legal', 'technical', 'diligence', 'governance', 'other')),
  access_level      TEXT NOT NULL DEFAULT 'backer'
                    CHECK (access_level IN ('public', 'backer', 'viewer', 'editor', 'manager', 'owner')),
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'archived', 'deleted')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_data_room_files_campaign
  ON campaign_data_room_files (campaign_id, status, access_level);

CREATE INDEX IF NOT EXISTS idx_campaign_data_room_files_category
  ON campaign_data_room_files (campaign_id, category);

CREATE TABLE IF NOT EXISTS campaign_data_room_access_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id           UUID NOT NULL REFERENCES campaign_data_room_files(id) ON DELETE CASCADE,
  campaign_id       UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  action            TEXT NOT NULL CHECK (action IN ('view', 'download', 'upload', 'update', 'delete')),
  ip_address        TEXT,
  user_agent        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_data_room_logs_campaign
  ON campaign_data_room_access_logs (campaign_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_campaign_data_room_logs_file
  ON campaign_data_room_access_logs (file_id, created_at DESC);
