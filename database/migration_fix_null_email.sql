-- Migration: Allow NULL emails for Facebook users who don't have emails
-- Run this in your Supabase SQL Editor

-- First, update existing users with null emails to use a fallback
UPDATE users 
SET email = 'fb_' || facebook_id || '@facebook.local'
WHERE email IS NULL OR email = '';

-- Now alter the table to allow NULL emails
-- Note: We'll keep UNIQUE constraint but allow NULL (PostgreSQL allows multiple NULLs in UNIQUE columns)
ALTER TABLE users 
ALTER COLUMN email DROP NOT NULL;

-- Add a comment explaining the change
COMMENT ON COLUMN users.email IS 'User email. Can be NULL for Facebook users without emails. Fallback format: fb_{facebook_id}@facebook.local';




