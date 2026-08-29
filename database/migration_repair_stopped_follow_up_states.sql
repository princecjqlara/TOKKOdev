-- Repair states created by the old follow-up logic. It applied the
-- reply_action='stop' rule to a contact's first reply, so step 1 was never
-- scheduled. Only never-sent states are repaired; legitimately stopped
-- sequences with delivery history remain untouched.

UPDATE workflow_automation_states AS state
SET status = 'active',
    stopped_at = NULL,
    stopped_reason = NULL,
    completed_at = NULL,
    current_step_index = 0,
    next_step_at = COALESCE(
        state.last_contact_reply_at,
        state.last_triggered_at,
        state.updated_at,
        NOW()
    ) + make_interval(
        mins => LEAST(
            10080,
            GREATEST(
                0,
                COALESCE(
                    NULLIF(automation.steps -> 0 ->> 'delay_minutes', '')::INTEGER,
                    automation.cooldown_minutes,
                    0
                )
            )
        )
    ),
    updated_at = NOW()
FROM workflow_automations AS automation
WHERE state.automation_id = automation.id
  AND automation.enabled = TRUE
  AND state.status = 'stopped'
  AND state.stopped_reason = 'contact_reply'
  AND state.last_sent_at IS NULL;

NOTIFY pgrst, 'reload schema';
