-- Migration: 20260929_team_fundraising_pages.sql
-- Supports: team fundraising pages under a parent campaign (#952)
--
-- A campaign can act as a parent that groups member campaigns (teams,
-- sub-projects) under one fundraising page. Members keep their own wallets,
-- contributions, and milestones; the parent page aggregates progress.
-- Membership is the single source of truth: a campaign is a "parent" when it
-- has rows here, and a "team member" when it appears as member_campaign_id.

CREATE TABLE IF NOT EXISTS team_campaign_members (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  member_campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  role               TEXT NOT NULL DEFAULT 'member'
                       CHECK (role IN ('owner', 'member')),
  display_order      INTEGER NOT NULL DEFAULT 0,
  invited_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  joined_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT team_campaign_members_unique_member
    UNIQUE (member_campaign_id),
  CONSTRAINT team_campaign_members_no_self_link
    CHECK (parent_campaign_id <> member_campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_team_campaign_members_parent
  ON team_campaign_members (parent_campaign_id, display_order);

CREATE INDEX IF NOT EXISTS idx_team_campaign_members_member
  ON team_campaign_members (member_campaign_id);
