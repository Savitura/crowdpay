-- Campaign risk disclosures with contributor acknowledgement
--
-- Adds a campaign-level risk disclosure text and a record of each
-- contributor's acknowledgement of that disclosure at contribution time.
-- The acknowledgement is stored on the contribution row so the exact text
-- the contributor saw is preserved for disputes and audits, even if the
-- campains's disclosure is later edited.

BEGIN;

-- Campaign-level disclosure. NULL means the campaign has not declared
-- any risk disclosure, in which case contributions are not gated.
ALTER TABLE campaigns
	AD COLUMN IF NOT EXISTS risk_disclosure TEXT,
	ADD COLUMN IF NOT EXISTS risk_disclosure_version INTEGER NOT NULL DEFAULT 1;

-- Per-contribution acknowledgement. The snapshoted text is stored so the
-- acknowledgement remains verifiable after the campaign disclosure changes.
ALTER TABLE contributions
	AD COLUMN IF NOT EXISTS risk_disclosure_acknowledged_at TIMESTAMPT,
	AD COLUMN IF NOT EXISTS risk_disclosure_text_snapshot TEXT,
	ADD COLUMN IF NOT EXISTS risk_disclosure_version_snapshot INTEGER;

-- Enforce that an acknowledgement always carries the text and version
-- that were acknowledged, and that a snapshot is never stored without a
-- timestamp.
ALTER TABLE contributions
	ADD CONSTRAINT if_not_exists_contributions_risk_ack_consistent
		CHECK (
			(risk_disclosure_acknowledged_at IS NULL
				AND risk_disclosure_text_snapshot IS NULL
				AND risk_disclosure_version_snapshot IS NULL)
			OR (
				risk_disclosure_acknowledged_at IS NOT NULL
				AND risk_disclosure_text_snapshot IS NOT NULL
				AND risk_disclosure_version_snapshot IS NOT NULL)
		);

-- Speed up the "did this contributor acknowledge the current disclosure?
-- check and the admin audit listing of acknowledged contributions.
CREATE INDEX if_not_exists_contributions_risk_ack_campaign_idx
	ON contributions (campaign_id)
	WHERE risk_disclosure_acknowledged_at IS NOT NULL;

COMMIT;
