-- Prevent abandoned legacy campaigns from starving newly-started durable
-- campaigns. A campaign becomes eligible when the user starts/resumes it.

ALTER TABLE public.campaigns
ADD COLUMN IF NOT EXISTS background_delivery_enabled BOOLEAN NOT NULL DEFAULT FALSE;

DROP INDEX IF EXISTS public.idx_campaigns_immediate_sending;

CREATE INDEX idx_campaigns_immediate_sending
ON public.campaigns (next_attempt_at, updated_at, id)
WHERE status = 'sending'
  AND scheduled_at IS NULL
  AND background_delivery_enabled
  AND NOT COALESCE(is_loop, FALSE);

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260814_012', 'Isolate explicitly resumed background campaigns from abandoned queues')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';
