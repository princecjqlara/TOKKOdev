-- Step templates live in the existing steps JSONB. The legacy first-delay
-- mirror must also allow a follow-up scheduled beyond seven days.
ALTER TABLE public.workflow_automations
    DROP CONSTRAINT IF EXISTS workflow_automations_cooldown_minutes_check;
ALTER TABLE public.workflow_automations
    ADD CONSTRAINT workflow_automations_cooldown_minutes_check
    CHECK (cooldown_minutes >= 0 AND cooldown_minutes <= 525600) NOT VALID;
ALTER TABLE public.workflow_automations
    VALIDATE CONSTRAINT workflow_automations_cooldown_minutes_check;
NOTIFY pgrst, 'reload schema';
