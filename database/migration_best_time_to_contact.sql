-- Best Time to Contact Feature Migration
-- Run this SQL in your Supabase SQL Editor

-- contact_interactions table to track individual message timestamps
CREATE TABLE IF NOT EXISTS contact_interactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    interaction_at TIMESTAMPTZ NOT NULL,
    hour_of_day INTEGER NOT NULL, -- 0-23 (for quick aggregation)
    day_of_week INTEGER NOT NULL, -- 0-6 (Sunday = 0)
    is_from_contact BOOLEAN DEFAULT TRUE, -- true if message from contact, false if from page
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_contact_interactions_contact_id ON contact_interactions(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_interactions_page_id ON contact_interactions(page_id);
CREATE INDEX IF NOT EXISTS idx_contact_interactions_hour ON contact_interactions(hour_of_day);
CREATE INDEX IF NOT EXISTS idx_contact_interactions_day ON contact_interactions(day_of_week);
CREATE INDEX IF NOT EXISTS idx_contact_interactions_interaction_at ON contact_interactions(interaction_at);

-- Add best_time_to_contact fields to contacts table
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS best_contact_hour INTEGER; -- 0-23
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS best_contact_confidence TEXT DEFAULT 'none'; -- 'high', 'medium', 'low', 'inferred', 'none'

-- Enable RLS on contact_interactions
ALTER TABLE contact_interactions ENABLE ROW LEVEL SECURITY;

-- Grant permissions
GRANT ALL ON contact_interactions TO postgres, anon, authenticated;
