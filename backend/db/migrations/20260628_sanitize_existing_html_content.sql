-- Backfill: strip any HTML tags left over from before input sanitization was
-- applied to campaign/milestone/reward-tier text fields (issue #383).
UPDATE campaigns
SET description = TRIM(regexp_replace(description, '<[^>]*>', '', 'g'))
WHERE description ~ '<[^>]*>';

UPDATE campaigns
SET title = TRIM(regexp_replace(title, '<[^>]*>', '', 'g'))
WHERE title ~ '<[^>]*>';

UPDATE milestones
SET title = TRIM(regexp_replace(title, '<[^>]*>', '', 'g'))
WHERE title ~ '<[^>]*>';

UPDATE milestones
SET description = TRIM(regexp_replace(description, '<[^>]*>', '', 'g'))
WHERE description ~ '<[^>]*>';

UPDATE reward_tiers
SET title = TRIM(regexp_replace(title, '<[^>]*>', '', 'g'))
WHERE title ~ '<[^>]*>';

UPDATE reward_tiers
SET description = TRIM(regexp_replace(description, '<[^>]*>', '', 'g'))
WHERE description ~ '<[^>]*>';
