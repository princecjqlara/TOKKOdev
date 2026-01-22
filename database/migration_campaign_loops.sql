-- Campaign Loops Migration
-- Run this SQL in your Supabase SQL Editor

-- Add loop campaign columns to campaigns table
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS is_loop BOOLEAN DEFAULT FALSE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ai_prompt TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS loop_status TEXT DEFAULT 'stopped'; -- 'active', 'paused', 'stopped'
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ;

-- Index for efficient cron queries (find active loop campaigns)
CREATE INDEX IF NOT EXISTS idx_campaigns_loop_active 
ON campaigns(is_loop, loop_status) WHERE is_loop = TRUE;

-- Add next_scheduled_at to campaign_recipients for loop rescheduling
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS next_scheduled_at TIMESTAMPTZ;

-- Add message_sent_count to track how many times a recipient received a loop message
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS message_sent_count INTEGER DEFAULT 0;

-- Add last_contacted_at to track when recipient was last contacted in loop
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ;

-- Index for finding due recipients in loop campaigns
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_next_scheduled 
ON campaign_recipients(next_scheduled_at, status) WHERE next_scheduled_at IS NOT NULL;

-- Add check constraint for loop_status values
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_loop_status_check'
    ) THEN
        ALTER TABLE campaigns ADD CONSTRAINT campaigns_loop_status_check 
        CHECK (loop_status IN ('active', 'paused', 'stopped'));
    END IF;
END $$;
