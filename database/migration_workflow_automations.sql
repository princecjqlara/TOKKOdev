-- Workflow automations for reply-triggered Human Agent messages

CREATE TABLE IF NOT EXISTS workflow_automations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    trigger_type TEXT NOT NULL DEFAULT 'contact_reply',
    message_text TEXT NOT NULL,
    stop_keywords JSONB NOT NULL DEFAULT '[]',
    page_stop_code TEXT,
    cooldown_minutes INTEGER NOT NULL DEFAULT 60,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT workflow_automations_trigger_type_check CHECK (trigger_type IN ('contact_reply')),
    CONSTRAINT workflow_automations_cooldown_minutes_check CHECK (cooldown_minutes >= 0 AND cooldown_minutes <= 10080)
);

CREATE TABLE IF NOT EXISTS workflow_automation_states (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    automation_id UUID NOT NULL REFERENCES workflow_automations(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'active',
    stopped_at TIMESTAMPTZ,
    stopped_reason TEXT,
    last_triggered_at TIMESTAMPTZ,
    last_sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(automation_id, contact_id),
    CONSTRAINT workflow_automation_states_status_check CHECK (status IN ('active', 'stopped'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_automations_page_enabled
ON workflow_automations(page_id, enabled, trigger_type);

CREATE INDEX IF NOT EXISTS idx_workflow_automation_states_contact
ON workflow_automation_states(contact_id, status);

CREATE INDEX IF NOT EXISTS idx_workflow_automation_states_automation
ON workflow_automation_states(automation_id, status);

DROP TRIGGER IF EXISTS update_workflow_automations_updated_at ON workflow_automations;
CREATE TRIGGER update_workflow_automations_updated_at BEFORE UPDATE ON workflow_automations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_workflow_automation_states_updated_at ON workflow_automation_states;
CREATE TRIGGER update_workflow_automation_states_updated_at BEFORE UPDATE ON workflow_automation_states
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE workflow_automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_automation_states ENABLE ROW LEVEL SECURITY;
