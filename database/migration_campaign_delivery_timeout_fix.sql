-- Remove high-volume tracked-campaign statement timeouts without adding a
-- large queue index. The compact queue primary key already starts with
-- (campaign_id, contact_id), so immediate sends can claim in contact-id order
-- instead of sorting the campaign's entire remaining audience for every batch.

CREATE OR REPLACE FUNCTION public.claim_campaign_recipients(
    p_campaign_id UUID,
    p_batch_size INTEGER DEFAULT 25,
    p_due_at TIMESTAMPTZ DEFAULT NULL,
    p_include_unscheduled BOOLEAN DEFAULT FALSE,
    p_lease INTERVAL DEFAULT INTERVAL '10 minutes'
)
RETURNS TABLE (
    contact_id UUID,
    contact_psid TEXT,
    contact_name TEXT,
    contact_best_hour INTEGER,
    claim_token UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_claim_token UUID := gen_random_uuid();
BEGIN
    IF p_batch_size < 1 OR p_batch_size > 500 THEN
        RAISE EXCEPTION 'p_batch_size must be between 1 and 500';
    END IF;

    IF p_lease < INTERVAL '1 minute' OR p_lease > INTERVAL '1 hour' THEN
        RAISE EXCEPTION 'p_lease must be between 1 minute and 1 hour';
    END IF;

    IF p_due_at IS NULL THEN
        RETURN QUERY
        WITH candidates AS (
            SELECT recipient.ctid
            FROM public.campaign_recipients AS recipient
            WHERE recipient.campaign_id = p_campaign_id
              AND (
                  recipient.status = 'pending'
                  OR (
                      recipient.status = 'processing'
                      AND recipient.claimed_at < NOW() - p_lease
                  )
              )
            -- Uses the compact (campaign_id, contact_id) primary key and stops
            -- after the requested rows instead of sorting the whole campaign.
            ORDER BY recipient.contact_id
            FOR UPDATE SKIP LOCKED
            LIMIT p_batch_size
        ),
        claimed AS (
            UPDATE public.campaign_recipients AS recipient
            SET status = 'processing',
                claim_token = v_claim_token,
                claimed_at = NOW()
            FROM candidates
            WHERE recipient.ctid = candidates.ctid
            RETURNING recipient.contact_id
        )
        SELECT
            claimed.contact_id,
            contact.psid,
            contact.name,
            contact.best_contact_hour,
            v_claim_token
        FROM claimed
        INNER JOIN public.contacts AS contact ON contact.id = claimed.contact_id;
    ELSE
        RETURN QUERY
        WITH candidates AS (
            SELECT recipient.ctid
            FROM public.campaign_recipients AS recipient
            WHERE recipient.campaign_id = p_campaign_id
              AND (
                  recipient.status = 'pending'
                  OR (
                      recipient.status = 'processing'
                      AND recipient.claimed_at < NOW() - p_lease
                  )
              )
              AND (
                  (p_include_unscheduled AND recipient.scheduled_at IS NULL AND recipient.next_scheduled_at IS NULL)
                  OR recipient.scheduled_at <= p_due_at
                  OR recipient.next_scheduled_at <= p_due_at
              )
            ORDER BY
                COALESCE(recipient.next_scheduled_at, recipient.scheduled_at, recipient.created_at),
                recipient.contact_id
            FOR UPDATE SKIP LOCKED
            LIMIT p_batch_size
        ),
        claimed AS (
            UPDATE public.campaign_recipients AS recipient
            SET status = 'processing',
                claim_token = v_claim_token,
                claimed_at = NOW()
            FROM candidates
            WHERE recipient.ctid = candidates.ctid
            RETURNING recipient.contact_id
        )
        SELECT
            claimed.contact_id,
            contact.psid,
            contact.name,
            contact.best_contact_hour,
            v_claim_token
        FROM claimed
        INNER JOIN public.contacts AS contact ON contact.id = claimed.contact_id;
    END IF;
END;
$$;

-- A fully materialized one-time campaign has exact durable counters, so its
-- remaining count is arithmetic. Older or scheduled/loop campaigns retain the
-- queue-count fallback until their materialization state is known.
CREATE OR REPLACE FUNCTION public.get_campaign_delivery_progress(p_campaign_id UUID)
RETURNS TABLE (
    sent_count INTEGER,
    failed_count INTEGER,
    remaining_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        campaign.sent_count,
        campaign.failed_count,
        CASE
            WHEN campaign.audience_materialized_at IS NOT NULL
             AND NOT COALESCE(campaign.is_loop, FALSE)
             AND COALESCE(campaign.recurrence, 'none') = 'none'
            THEN GREATEST(
                campaign.total_recipients - campaign.sent_count - campaign.failed_count,
                0
            )::BIGINT
            ELSE (
                SELECT COUNT(*)::BIGINT
                FROM public.campaign_recipients AS recipient
                WHERE recipient.campaign_id = campaign.id
                  AND recipient.status IN ('pending', 'processing')
            )
        END
    FROM public.campaigns AS campaign
    WHERE campaign.id = p_campaign_id;
$$;

REVOKE ALL ON FUNCTION public.claim_campaign_recipients(UUID, INTEGER, TIMESTAMPTZ, BOOLEAN, INTERVAL) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_campaign_delivery_progress(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_campaign_recipients(UUID, INTEGER, TIMESTAMPTZ, BOOLEAN, INTERVAL) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.get_campaign_delivery_progress(UUID) TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260812_008', 'Remove tracked campaign delivery statement timeouts')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';
