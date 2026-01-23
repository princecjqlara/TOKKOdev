-- Migration: Add Password Authentication
-- Run this in Supabase SQL Editor

-- Add password_hash column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Add role column (admin or user)
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user';

-- Add is_active column to enable/disable users
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- Create index for faster email lookups on login
CREATE INDEX IF NOT EXISTS idx_users_email_active ON users(email) WHERE is_active = true;

-- Insert default admin user
-- Password: changeme123 (bcrypt hash with 10 rounds)
INSERT INTO users (email, name, password_hash, role, is_active)
VALUES (
    'admin@tokko.local',
    'Admin',
    '$2a$10$3euPcmQFCibsmXK6jnNgXuRfxAzCmW3Rf0H.SrNMLlLbFfLs.OYTC',
    'admin',
    true
)
ON CONFLICT (email) DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    role = EXCLUDED.role,
    is_active = EXCLUDED.is_active;
