-- Complete Migration: Add all missing columns to campaigns table
-- Run this in Supabase SQL Editor

-- Core campaign scheduling columns
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS scheduled_date TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS use_best_time BOOLEAN DEFAULT FALSE;

-- Loop campaign columns
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS is_loop BOOLEAN DEFAULT FALSE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ai_prompt TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS loop_status TEXT DEFAULT 'stopped';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ;

-- AI personalized messages for non-loop campaigns
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS use_ai_message BOOLEAN DEFAULT FALSE;

-- Campaign recipients additional columns
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS next_scheduled_at TIMESTAMPTZ;
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS message_sent_count INTEGER DEFAULT 0;
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ;

-- Contacts best time columns
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS best_contact_hours JSONB DEFAULT '[]';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS interaction_count INTEGER DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS best_contact_hour INTEGER;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS best_contact_confidence TEXT DEFAULT 'none';
