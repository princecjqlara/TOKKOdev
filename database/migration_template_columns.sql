-- Migration: Add template_name and template_language columns to campaigns table
-- These columns store the WhatsApp/Facebook approved template details for non-AI campaigns

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS template_name TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS template_language TEXT;

-- Documentation
COMMENT ON COLUMN campaigns.template_name IS 'Name of the approved message template to use (e.g. WhatsApp Business template). NULL for AI or loop campaigns.';
COMMENT ON COLUMN campaigns.template_language IS 'Language code for the message template (e.g. en_US). Defaults to en_US when template_name is set.';
