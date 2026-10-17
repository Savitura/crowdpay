-- Add CHECK constraints to prevent zero or negative amounts in campaigns
-- This prevents division by zero in campaign progress calculations and
-- ensures data integrity for financial fields

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_target_amount_positive CHECK (target_amount > 0),
  ADD CONSTRAINT campaigns_min_contribution_positive CHECK (min_contribution > 0),
  ADD CONSTRAINT campaigns_max_contribution_positive CHECK (max_contribution > 0),
  ADD CONSTRAINT campaigns_max_per_user_positive CHECK (max_per_user > 0);
