ALTER TABLE campaigns ADD COLUMN withdrawal_team_approvals_required SMALLINT NOT NULL DEFAULT 0
  CHECK (withdrawal_team_approvals_required BETWEEN 0 AND 10);
ALTER TABLE withdrawal_requests ADD COLUMN team_approvals_required SMALLINT NOT NULL DEFAULT 0
  CHECK (team_approvals_required BETWEEN 0 AND 10);

CREATE TABLE withdrawal_team_approvals (
  withdrawal_request_id UUID NOT NULL REFERENCES withdrawal_requests(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  member_id UUID REFERENCES campaign_members(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (withdrawal_request_id, user_id)
);
CREATE INDEX withdrawal_team_approvals_user_idx ON withdrawal_team_approvals(user_id);
CREATE INDEX withdrawal_team_approvals_member_idx ON withdrawal_team_approvals(member_id);
