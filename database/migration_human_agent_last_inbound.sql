-- Track the customer's last actual message separately from conversation activity.
-- Conversation updated_time also advances when the Page sends a message and must
-- never be used to determine the Messenger Human Agent window.
ALTER TABLE public.contacts
ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_page_last_inbound
ON public.contacts (page_id, last_inbound_at DESC)
WHERE last_inbound_at IS NOT NULL;

-- Webhooks and full syncs can overlap. Never let an older sync result move the
-- customer's last-message clock backwards.
CREATE OR REPLACE FUNCTION public.preserve_contact_last_inbound_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.last_inbound_at IS NOT NULL THEN
        NEW.last_inbound_at := GREATEST(OLD.last_inbound_at, NEW.last_inbound_at);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS preserve_contact_last_inbound_at ON public.contacts;
CREATE TRIGGER preserve_contact_last_inbound_at
BEFORE UPDATE ON public.contacts
FOR EACH ROW EXECUTE FUNCTION public.preserve_contact_last_inbound_at();

-- Backfill recent inbound events so existing contacts can appear immediately.
-- Older history is irrelevant to the current seven-day window.
DO $$
BEGIN
    IF to_regclass('app_private.contact_interaction_hourly_stats') IS NOT NULL THEN
        UPDATE public.contacts AS c
        SET last_inbound_at = recent.last_inbound_at
        FROM (
            SELECT contact_id, MAX(last_interaction_at) AS last_inbound_at
            FROM app_private.contact_interaction_hourly_stats
            WHERE is_from_contact = TRUE
              AND last_interaction_at >= NOW() - INTERVAL '7 days'
            GROUP BY contact_id
        ) AS recent
        WHERE c.id = recent.contact_id
          AND (c.last_inbound_at IS NULL OR c.last_inbound_at < recent.last_inbound_at);
    ELSIF to_regclass('public.contact_interactions') IS NOT NULL THEN
        UPDATE public.contacts AS c
        SET last_inbound_at = recent.last_inbound_at
        FROM (
            SELECT contact_id, MAX(interaction_at) AS last_inbound_at
            FROM public.contact_interactions
            WHERE is_from_contact = TRUE
              AND interaction_at >= NOW() - INTERVAL '7 days'
            GROUP BY contact_id
        ) AS recent
        WHERE c.id = recent.contact_id
          AND (c.last_inbound_at IS NULL OR c.last_inbound_at < recent.last_inbound_at);
    END IF;
END $$;
