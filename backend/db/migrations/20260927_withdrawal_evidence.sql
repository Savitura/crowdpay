ALTER TABLE withdrawal_requests ADD COLUMN evidence JSONB DEFAULT '[]'::jsonb;
