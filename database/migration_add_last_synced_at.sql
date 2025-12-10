-- Migration: Add last_synced_at to pages table for incremental syncing
-- Run this in your Supabase SQL Editor

ALTER TABLE pages 
ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pages_last_synced_at ON pages(last_synced_at);

UPDATE pages 
SET last_synced_at = created_at 
WHERE last_synced_at IS NULL;
