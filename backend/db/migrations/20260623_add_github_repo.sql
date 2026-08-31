ALTER TABLE campaigns
ADD COLUMN github_repo_url TEXT,
ADD COLUMN campaign_github_stats JSONB;
