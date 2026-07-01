-- Issue #331: partial index for unrefunded contributions per campaign (refund processing)
CREATE INDEX IF NOT EXISTS idx_contributions_campaign_unrefunded
  ON contributions (campaign_id)
  WHERE refunded = FALSE;
