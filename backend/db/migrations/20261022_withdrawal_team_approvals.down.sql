-- Refuse to remove an active gate on an unfinished withdrawal.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM withdrawal_requests
             WHERE team_approvals_required > 0 AND status IN ('pending', 'approved')) THEN
    RAISE EXCEPTION 'Finish or cancel withdrawals requiring team approval before rollback';
  END IF;
END $$;
DROP TABLE withdrawal_team_approvals;
ALTER TABLE withdrawal_requests DROP COLUMN team_approvals_required;
ALTER TABLE campaigns DROP COLUMN withdrawal_team_approvals_required;
