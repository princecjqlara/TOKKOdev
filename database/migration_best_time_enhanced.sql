-- Migration: Enhanced Best Time to Contact with Multiple Hours
-- Run this in Supabase SQL Editor

-- Add column for multiple best hours (JSON array of {hour: number, count: number})
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS best_contact_hours JSONB DEFAULT '[]';

-- Add column for total interaction count analyzed
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS interaction_count INTEGER DEFAULT 0;

-- Ensure single best hour columns exist for backwards compatibility
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS best_contact_hour INTEGER;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS best_contact_confidence TEXT DEFAULT 'none';

-- Example of what best_contact_hours will look like:
-- [{"hour": 10, "count": 15}, {"hour": 14, "count": 8}, {"hour": 19, "count": 5}]
-- This shows the contact is most active at 10am (15 messages), 2pm (8 messages), and 7pm (5 messages)
