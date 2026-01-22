-- Best Time Campaign Scheduling Migration
-- Run this SQL in your Supabase SQL Editor

-- Add scheduled_at to campaign_recipients for per-contact scheduling
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;

-- Index for efficient cron queries (find due scheduled messages)
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_scheduled 
ON campaign_recipients(scheduled_at, status) WHERE scheduled_at IS NOT NULL;

-- Add use_best_time flag to campaigns
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS use_best_time BOOLEAN DEFAULT FALSE;

-- Add scheduled_date to campaigns (the date user selected for sending)
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS scheduled_date DATE;
