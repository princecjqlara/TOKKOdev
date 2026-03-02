CREATE TABLE IF NOT EXISTS tag_shares (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    shared_with_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tag_id, shared_with_user_id)
);

ALTER TABLE contact_tags
ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tag_shares_tag_id ON tag_shares(tag_id);
CREATE INDEX IF NOT EXISTS idx_tag_shares_shared_with_user_id ON tag_shares(shared_with_user_id);
CREATE INDEX IF NOT EXISTS idx_contact_tags_created_by ON contact_tags(created_by);
