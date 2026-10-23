CREATE TABLE IF NOT EXISTS campaign_budget_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    title VARCHAR(100) NOT NULL,
    amount NUMERIC NOT NULL CHECK (amount > 0),
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_budget_categories_campaign_id ON campaign_budget_categories(campaign_id);

-- Budget line items (actual spend) that roll up under a campaign budget category.
CREATE TABLE IF NOT EXISTS campaign_budget_line_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuuid(),
    category_id UUID NOT NULL REFERENCES campaign_budget_categories(id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    title VARCHAR(150) NOT NULL,
    planned_amount NUMERIC NOT NULL CHECK (planned_amount >= 0),
    actual_amount NUMERIC NOT NULL DEFAULT 0 CHECK (actual_amount >= 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_budget_line_items_category_id ON campaign_budget_line_items(category_id);
CREATE INDEX IF NOT EXISTS idx_campaign_budget_line_items_campaign_id ON campaign_budget_line_items(campaign_id);
