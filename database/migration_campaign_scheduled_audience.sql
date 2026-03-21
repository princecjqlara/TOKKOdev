-- Scheduled campaign audience rules migration
-- Run this in Supabase SQL Editor

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_mode TEXT DEFAULT 'specific';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_start_date DATE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_include_tag_ids JSONB DEFAULT '[]';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_exclude_tag_ids JSONB DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled_at
ON campaigns(scheduled_at, status)
WHERE scheduled_at IS NOT NULL;
