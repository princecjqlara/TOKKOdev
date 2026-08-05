-- Shared, page-scoped audit trail for bulk actions that are not campaigns.
-- Campaigns remain the source of truth for bulk-message delivery history.
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
