-- Migration: Add use_ai_message column to campaigns table
-- This enables AI personalized messages for non-loop campaigns

-- Add use_ai_message column to campaigns table
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS use_ai_message BOOLEAN DEFAULT FALSE;

-- Comment for documentation
COMMENT ON COLUMN campaigns.use_ai_message IS 'When true, AI generates personalized messages for each contact using conversation history. Works for both loop and regular campaigns.';
