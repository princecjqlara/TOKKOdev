    -- Tokko Database Schema
    -- Run this SQL in your Supabase SQL Editor

    -- Enable UUID extension
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    -- Users table
    CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        email TEXT UNIQUE, -- Can be NULL for Facebook users without emails
        name TEXT,
        image TEXT,
        facebook_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Businesses table (for multi-user/business support)
    CREATE TABLE IF NOT EXISTS businesses (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Business users table (linking users to businesses)
    CREATE TABLE IF NOT EXISTS business_users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(business_id, user_id)
    );

    -- Pages table (Facebook pages)
    CREATE TABLE IF NOT EXISTS pages (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        fb_page_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        access_token TEXT NOT NULL,
        business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
        last_synced_at TIMESTAMPTZ, -- Timestamp of last successful sync (for incremental syncing)
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- User pages table (linking users to pages)
    CREATE TABLE IF NOT EXISTS user_pages (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, page_id)
    );

    -- Contacts table (Facebook page contacts/conversations)
    CREATE TABLE IF NOT EXISTS contacts (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        psid TEXT NOT NULL,
        name TEXT,
        profile_pic TEXT,
        last_interaction_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT contacts_name_not_placeholder CHECK (
            name IS NULL
            OR (
                btrim(name) <> ''
                AND lower(btrim(name)) NOT IN ('unknown', 'unknown name', 'unknown user', 'facebook user', 'messenger contact', 'undefined', 'null')
            )
        ),
        UNIQUE(page_id, psid)
    );

    -- Tags table
    CREATE TABLE IF NOT EXISTS tags (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name TEXT NOT NULL,
        color TEXT DEFAULT '#3B82F6',
        owner_type TEXT NOT NULL DEFAULT 'user', -- 'user', 'page', 'business'
        owner_id UUID NOT NULL, -- References user_id, page_id, or business_id based on owner_type
        page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
        is_shared BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Contact tags table (many-to-many relationship)
    CREATE TABLE IF NOT EXISTS tag_shares (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        shared_with_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(tag_id, shared_with_user_id)
    );

    -- Contact tags table (many-to-many relationship)
    CREATE TABLE IF NOT EXISTS contact_tags (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(contact_id, tag_id)
    );

    -- Campaigns table
    CREATE TABLE IF NOT EXISTS campaigns (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        message_text TEXT,
        status TEXT NOT NULL DEFAULT 'draft', -- 'draft', 'scheduled', 'sending', 'completed', 'cancelled'
        scheduled_at TIMESTAMPTZ,
        audience_mode TEXT DEFAULT 'specific', -- 'specific' or 'dynamic'
        audience_start_date DATE,
        audience_include_tag_ids JSONB DEFAULT '[]',
        audience_exclude_tag_ids JSONB DEFAULT '[]',
        audience_materialized_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        recipient_history_purged_at TIMESTAMPTZ,
        total_recipients INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Campaign recipients table (tracks which contacts receive which campaigns)
    CREATE TABLE IF NOT EXISTS campaign_recipients (
        campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'sent', 'failed'
        scheduled_at TIMESTAMPTZ,
        next_scheduled_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ,
        error_message TEXT,
        claim_token UUID,
        claimed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        message_sent_count INTEGER DEFAULT 0,
        last_contacted_at TIMESTAMPTZ,
        PRIMARY KEY(campaign_id, contact_id)
    );

    -- Only failures need recipient-level history. Successful one-time delivery
    -- rows are deleted immediately after campaign counters are incremented.
    CREATE TABLE IF NOT EXISTS campaign_delivery_failures (
        campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        error_message TEXT NOT NULL,
        failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        attempt_count SMALLINT NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
        PRIMARY KEY(campaign_id, contact_id)
    );

    -- Shared page audit history for bulk actions outside campaign sending
    CREATE TABLE IF NOT EXISTS page_activity_history (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        action_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id UUID,
        status TEXT NOT NULL DEFAULT 'completed',
        summary TEXT NOT NULL,
        target_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT page_activity_history_status_check
            CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled')),
        CONSTRAINT page_activity_history_counts_check
            CHECK (target_count >= 0 AND success_count >= 0 AND failure_count >= 0)
    );

    CREATE INDEX IF NOT EXISTS idx_page_activity_history_page_created
        ON page_activity_history(page_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_page_activity_history_actor
        ON page_activity_history(actor_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_page_activity_history_action
        ON page_activity_history(action_type, created_at DESC);

    -- Workflow automations table (multi-step follow-up messages)
    CREATE TABLE IF NOT EXISTS workflow_automations (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        trigger_type TEXT NOT NULL DEFAULT 'follow_up',
        message_text TEXT NOT NULL,
        stop_keywords JSONB NOT NULL DEFAULT '[]',
        steps JSONB NOT NULL DEFAULT '[]',
        reply_action TEXT NOT NULL DEFAULT 'reset',
        page_stop_code TEXT,
        cooldown_minutes INTEGER NOT NULL DEFAULT 60,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT workflow_automations_trigger_type_check CHECK (trigger_type IN ('contact_reply', 'follow_up')),
        CONSTRAINT workflow_automations_reply_action_check CHECK (reply_action IN ('stop', 'reset', 'continue')),
        CONSTRAINT workflow_automations_cooldown_minutes_check CHECK (cooldown_minutes >= 0 AND cooldown_minutes <= 10080)
    );

    -- Workflow automation states table (per-contact progress and send history)
    CREATE TABLE IF NOT EXISTS workflow_automation_states (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        automation_id UUID NOT NULL REFERENCES workflow_automations(id) ON DELETE CASCADE,
        contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'active',
        current_step_index INTEGER NOT NULL DEFAULT 0,
        next_step_at TIMESTAMPTZ,
        stopped_at TIMESTAMPTZ,
        stopped_reason TEXT,
        last_triggered_at TIMESTAMPTZ,
        last_sent_at TIMESTAMPTZ,
        last_contact_reply_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(automation_id, contact_id),
        CONSTRAINT workflow_automation_states_status_check CHECK (status IN ('active', 'stopped', 'completed'))
    );

    -- Indexes for better query performance
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_facebook_id ON users(facebook_id);
    CREATE INDEX IF NOT EXISTS idx_pages_fb_page_id ON pages(fb_page_id);
    CREATE INDEX IF NOT EXISTS idx_user_pages_user_id ON user_pages(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_pages_page_id ON user_pages(page_id);
    -- UNIQUE (page_id, psid) already provides the contact lookup index.
    CREATE INDEX IF NOT EXISTS idx_contact_tags_contact_id ON contact_tags(contact_id);
    CREATE INDEX IF NOT EXISTS idx_contact_tags_tag_id ON contact_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_contact_tags_created_by ON contact_tags(created_by);
    CREATE INDEX IF NOT EXISTS idx_tags_owner_type ON tags(owner_type);
    CREATE INDEX IF NOT EXISTS idx_tags_owner_id ON tags(owner_id);
    CREATE INDEX IF NOT EXISTS idx_tags_page_id ON tags(page_id);
    CREATE INDEX IF NOT EXISTS idx_tags_is_shared ON tags(is_shared);
    CREATE INDEX IF NOT EXISTS idx_tag_shares_tag_id ON tag_shares(tag_id);
    CREATE INDEX IF NOT EXISTS idx_tag_shares_shared_with_user_id ON tag_shares(shared_with_user_id);
    CREATE INDEX IF NOT EXISTS idx_campaigns_page_id ON campaigns(page_id);
    CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
    CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled_at ON campaigns(scheduled_at);
    -- UNIQUE (campaign_id, contact_id) already indexes campaign_id.
    CREATE INDEX IF NOT EXISTS idx_campaign_recipients_contact_id ON campaign_recipients(contact_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_delivery_failures_campaign_failed ON campaign_delivery_failures(campaign_id, failed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_automations_page_enabled ON workflow_automations(page_id, enabled, trigger_type);
    CREATE INDEX IF NOT EXISTS idx_workflow_automation_states_contact ON workflow_automation_states(contact_id, status);
    CREATE INDEX IF NOT EXISTS idx_workflow_automation_states_automation ON workflow_automation_states(automation_id, status);
    CREATE INDEX IF NOT EXISTS idx_workflow_automation_states_due ON workflow_automation_states(next_step_at, status) WHERE next_step_at IS NOT NULL;

    -- Function to update updated_at timestamp
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
    END;
    $$ language 'plpgsql';

    -- Triggers to automatically update updated_at
    CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    CREATE TRIGGER update_pages_updated_at BEFORE UPDATE ON pages
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    CREATE TRIGGER update_contacts_updated_at BEFORE UPDATE ON contacts
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    CREATE TRIGGER update_tags_updated_at BEFORE UPDATE ON tags
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    CREATE TRIGGER update_campaigns_updated_at BEFORE UPDATE ON campaigns
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    CREATE TRIGGER update_workflow_automations_updated_at BEFORE UPDATE ON workflow_automations
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    CREATE TRIGGER update_workflow_automation_states_updated_at BEFORE UPDATE ON workflow_automation_states
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    -- Row Level Security (RLS) Policies
    -- Enable RLS on all tables
    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
    ALTER TABLE business_users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE user_pages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tag_shares ENABLE ROW LEVEL SECURITY;
    ALTER TABLE contact_tags ENABLE ROW LEVEL SECURITY;
    ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
    ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;
    ALTER TABLE campaign_delivery_failures ENABLE ROW LEVEL SECURITY;
    ALTER TABLE workflow_automations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE workflow_automation_states ENABLE ROW LEVEL SECURITY;

    -- Note: Since we're using service role key in the API routes,
    -- RLS policies are bypassed. But we can add policies for future use:
    -- Example policy for users (users can only see their own data):
    -- CREATE POLICY "Users can view own data" ON users
    --     FOR SELECT USING (auth.uid()::text = id::text);

    -- Grant necessary permissions (adjust based on your setup)
    -- The service role key bypasses RLS, so these are mainly for reference
    GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, anon, authenticated;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, anon, authenticated;

