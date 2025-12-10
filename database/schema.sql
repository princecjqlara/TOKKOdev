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
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Contact tags table (many-to-many relationship)
    CREATE TABLE IF NOT EXISTS contact_tags (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
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
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        total_recipients INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Campaign recipients table (tracks which contacts receive which campaigns)
    CREATE TABLE IF NOT EXISTS campaign_recipients (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'sent', 'failed'
        sent_at TIMESTAMPTZ,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(campaign_id, contact_id)
    );

    -- Indexes for better query performance
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_facebook_id ON users(facebook_id);
    CREATE INDEX IF NOT EXISTS idx_pages_fb_page_id ON pages(fb_page_id);
    CREATE INDEX IF NOT EXISTS idx_user_pages_user_id ON user_pages(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_pages_page_id ON user_pages(page_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_page_id ON contacts(page_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_psid ON contacts(psid);
    CREATE INDEX IF NOT EXISTS idx_contacts_page_psid ON contacts(page_id, psid);
    CREATE INDEX IF NOT EXISTS idx_contact_tags_contact_id ON contact_tags(contact_id);
    CREATE INDEX IF NOT EXISTS idx_contact_tags_tag_id ON contact_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_tags_owner_type ON tags(owner_type);
    CREATE INDEX IF NOT EXISTS idx_tags_owner_id ON tags(owner_id);
    CREATE INDEX IF NOT EXISTS idx_tags_page_id ON tags(page_id);
    CREATE INDEX IF NOT EXISTS idx_campaigns_page_id ON campaigns(page_id);
    CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
    CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign_id ON campaign_recipients(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_recipients_contact_id ON campaign_recipients(contact_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_recipients_status ON campaign_recipients(status);

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

    -- Row Level Security (RLS) Policies
    -- Enable RLS on all tables
    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
    ALTER TABLE business_users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE user_pages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
    ALTER TABLE contact_tags ENABLE ROW LEVEL SECURITY;
    ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
    ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;

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

