-- Multi-step follow-up automations.

ALTER TABLE workflow_automations
ADD COLUMN IF NOT EXISTS steps JSONB NOT NULL DEFAULT '[]';

ALTER TABLE workflow_automations
ADD COLUMN IF NOT EXISTS reply_action TEXT NOT NULL DEFAULT 'reset';

ALTER TABLE workflow_automation_states
ADD COLUMN IF NOT EXISTS current_step_index INTEGER NOT NULL DEFAULT 0;

ALTER TABLE workflow_automation_states
ADD COLUMN IF NOT EXISTS next_step_at TIMESTAMPTZ;

ALTER TABLE workflow_automation_states
ADD COLUMN IF NOT EXISTS last_contact_reply_at TIMESTAMPTZ;

ALTER TABLE workflow_automation_states
ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

UPDATE workflow_automations
SET steps = jsonb_build_array(
    jsonb_build_object(
        'message_text', message_text,
        'delay_minutes', cooldown_minutes
    )
)
WHERE steps = '[]'::jsonb
  AND COALESCE(NULLIF(TRIM(message_text), ''), '') <> '';

ALTER TABLE workflow_automations
DROP CONSTRAINT IF EXISTS workflow_automations_trigger_type_check;

ALTER TABLE workflow_automations
ADD CONSTRAINT workflow_automations_trigger_type_check
CHECK (trigger_type IN ('contact_reply', 'follow_up'));

ALTER TABLE workflow_automations
DROP CONSTRAINT IF EXISTS workflow_automations_reply_action_check;

ALTER TABLE workflow_automations
ADD CONSTRAINT workflow_automations_reply_action_check
CHECK (reply_action IN ('stop', 'reset', 'continue'));

ALTER TABLE workflow_automation_states
DROP CONSTRAINT IF EXISTS workflow_automation_states_status_check;

ALTER TABLE workflow_automation_states
ADD CONSTRAINT workflow_automation_states_status_check
CHECK (status IN ('active', 'stopped', 'completed'));

CREATE INDEX IF NOT EXISTS idx_workflow_automation_states_due
ON workflow_automation_states(next_step_at, status)
WHERE next_step_at IS NOT NULL;

-- Refresh PostgREST immediately so API queries can use the new columns.
NOTIFY pgrst, 'reload schema';
