-- Migration: Add last_synced_at to pages table for incremental syncing
-- Run this in your Supabase SQL Editor

ALTER TABLE pages 
ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_pages_last_synced_at ON pages(last_synced_at);

-- Set initial value for existing pages (set to a date in the past to trigger full sync)
UPDATE pages 
SET last_synced_at = created_at 
WHERE last_synced_at IS NULL;

