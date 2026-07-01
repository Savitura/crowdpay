-- Migration: Validate milestone percentage totals
-- Date: 2026-06-28
-- Description: Identify campaigns with milestone percentages that exceed 100%
-- This is a data validation migration to report issues, not fix them automatically

-- Create a report view for administrators to check milestone percentage totals
DROP VIEW IF EXISTS milestone_percentage_report;
CREATE VIEW milestone_percentage_report AS
WITH milestone_totals AS (
    SELECT 
        c.id AS campaign_id,
        c.title AS campaign_title,
        c.status AS campaign_status,
        COUNT(m.id) AS milestone_count,
        SUM(m.release_percentage) AS total_percentage,
        BOOL_OR(m.release_percentage > 100) AS any_milestone_over_100
    FROM campaigns c
    LEFT JOIN milestones m ON m.campaign_id = c.id
    WHERE c.deleted_at IS NULL
    GROUP BY c.id, c.title, c.status
    HAVING COUNT(m.id) > 0
)
SELECT 
    campaign_id,
    campaign_title,
    milestone_count,
    total_percentage,
    campaign_status,
    -- Check if total percentage exceeds 100% (with small epsilon for floating point)
    (total_percentage > 100.001) AS exceeds_100_percent,
    any_milestone_over_100
FROM milestone_totals
ORDER BY exceeds_100_percent DESC, total_percentage DESC;

-- Comment: To check for campaigns with invalid milestone percentages, run:
-- SELECT * FROM milestone_percentage_report WHERE exceeds_100_percent = true;
-- This will show campaigns where milestone percentages exceed 100%

-- Also create a simpler query for one-time validation check
COMMENT ON VIEW milestone_percentage_report IS 'Reports campaigns with milestone percentage totals, highlighting those exceeding 100%';

-- One-time validation check (can be run manually by administrators)
-- Uncomment the following lines to run the validation check:
/*
DO $$
DECLARE
    invalid_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO invalid_count
    FROM milestone_percentage_report 
    WHERE exceeds_100_percent = true;
    
    IF invalid_count > 0 THEN
        RAISE NOTICE 'Found % campaigns with milestone percentages exceeding 100%', invalid_count;
        RAISE NOTICE 'Run: SELECT * FROM milestone_percentage_report WHERE exceeds_100_percent = true; for details';
    ELSE
        RAISE NOTICE 'All campaigns have valid milestone percentage totals (<= 100%)';
    END IF;
END $$;
*/