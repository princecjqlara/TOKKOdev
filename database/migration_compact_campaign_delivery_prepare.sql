-- Compact, concurrency-safe campaign delivery queue.
--
-- This migration is deliberately additive so it can be applied before the
-- application deployment. Run migration_compact_campaign_delivery_finalize.sql
-- only after every sender has been upgraded to use the RPCs below.

ALTER TABLE public.campaign_recipients
    ADD COLUMN IF NOT EXISTS claim_token UUID,
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

ALTER TABLE public.campaigns
    ADD COLUMN IF NOT EXISTS audience_materialized_at TIMESTAMPTZ;

-- Existing dynamic campaigns already have a materialized audience. Recording
-- that fact prevents a compact sender from re-inserting successful recipients.
UPDATE public.campaigns AS campaign
SET audience_materialized_at = COALESCE(campaign.started_at, campaign.updated_at, NOW())
WHERE campaign.audience_mode = 'dynamic'
  AND campaign.audience_materialized_at IS NULL
  AND EXISTS (
      SELECT 1 FROM public.campaign_recipients AS recipient
      WHERE recipient.campaign_id = campaign.id
  );

ALTER TABLE public.campaign_recipients
    DROP CONSTRAINT IF EXISTS campaign_recipients_status_check;

ALTER TABLE public.campaign_recipients
    ADD CONSTRAINT campaign_recipients_status_check
    CHECK (status IN ('pending', 'processing', 'sent', 'failed')) NOT VALID;

ALTER TABLE public.campaign_recipients
    VALIDATE CONSTRAINT campaign_recipients_status_check;

CREATE TABLE IF NOT EXISTS public.campaign_delivery_failures (
    campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    error_message TEXT NOT NULL,
    failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempt_count SMALLINT NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
    PRIMARY KEY (campaign_id, contact_id)
);

ALTER TABLE public.campaign_delivery_failures ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_campaign_delivery_failures_campaign_failed
    ON public.campaign_delivery_failures(campaign_id, failed_at DESC);

INSERT INTO public.campaign_delivery_failures (
    campaign_id, contact_id, error_message, failed_at, attempt_count
)
SELECT
    recipient.campaign_id,
    recipient.contact_id,
    COALESCE(NULLIF(recipient.error_message, ''), 'Unknown delivery error'),
    COALESCE(recipient.last_contacted_at, recipient.created_at, NOW()),
    1
FROM public.campaign_recipients AS recipient
WHERE recipient.status = 'failed'
ON CONFLICT (campaign_id, contact_id) DO UPDATE
SET error_message = EXCLUDED.error_message,
    failed_at = EXCLUDED.failed_at;

-- Keep failure reads complete during the prepare/deploy/finalize transition,
-- including failures written by an older application instance.
CREATE OR REPLACE FUNCTION app_private.mirror_campaign_delivery_failure()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.status = 'failed'
       AND COALESCE(NEW.error_message, '') <> 'Campaign cancelled by user' THEN
        INSERT INTO public.campaign_delivery_failures (
            campaign_id, contact_id, error_message, failed_at, attempt_count
        ) VALUES (
            NEW.campaign_id,
            NEW.contact_id,
            COALESCE(NULLIF(NEW.error_message, ''), 'Unknown delivery error'),
            NOW(),
            1
        )
        ON CONFLICT (campaign_id, contact_id) DO UPDATE
        SET error_message = EXCLUDED.error_message,
            failed_at = EXCLUDED.failed_at,
            attempt_count = LEAST(32767, public.campaign_delivery_failures.attempt_count + 1);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mirror_campaign_delivery_failure ON public.campaign_recipients;
CREATE TRIGGER mirror_campaign_delivery_failure
AFTER INSERT OR UPDATE OF status, error_message ON public.campaign_recipients
FOR EACH ROW
WHEN (NEW.status = 'failed')
EXECUTE FUNCTION app_private.mirror_campaign_delivery_failure();

REVOKE ALL ON FUNCTION app_private.mirror_campaign_delivery_failure() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.mirror_campaign_delivery_failure() TO postgres;

-- Extend the existing bounded retention job to the compact failure table.
CREATE OR REPLACE FUNCTION public.cleanup_terminal_campaign_recipients(
    retention INTERVAL DEFAULT INTERVAL '1 day',
    batch_size INTEGER DEFAULT 50000
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_queue_deleted INTEGER := 0;
    v_failures_deleted INTEGER := 0;
BEGIN
    IF retention < INTERVAL '1 day' THEN
        RAISE EXCEPTION 'retention must be at least 1 day';
    END IF;
    IF batch_size < 1 OR batch_size > 100000 THEN
        RAISE EXCEPTION 'batch_size must be between 1 and 100000';
    END IF;

    WITH doomed AS (
        SELECT recipient.ctid
        FROM public.campaign_recipients AS recipient
        INNER JOIN public.campaigns AS campaign ON campaign.id = recipient.campaign_id
        WHERE campaign.status IN ('completed', 'cancelled', 'failed')
          AND COALESCE(campaign.completed_at, campaign.updated_at, campaign.created_at) < NOW() - retention
        LIMIT batch_size
    )
    DELETE FROM public.campaign_recipients AS recipient
    USING doomed
    WHERE recipient.ctid = doomed.ctid;
    GET DIAGNOSTICS v_queue_deleted = ROW_COUNT;

    IF v_queue_deleted < batch_size THEN
        WITH doomed AS (
            SELECT failure.ctid
            FROM public.campaign_delivery_failures AS failure
            INNER JOIN public.campaigns AS campaign ON campaign.id = failure.campaign_id
            WHERE campaign.status IN ('completed', 'cancelled', 'failed')
              AND COALESCE(campaign.completed_at, campaign.updated_at, campaign.created_at) < NOW() - retention
            LIMIT batch_size - v_queue_deleted
        )
        DELETE FROM public.campaign_delivery_failures AS failure
        USING doomed
        WHERE failure.ctid = doomed.ctid;
        GET DIAGNOSTICS v_failures_deleted = ROW_COUNT;
    END IF;

    UPDATE public.campaigns AS campaign
    SET recipient_history_purged_at = NOW()
    WHERE campaign.status IN ('completed', 'cancelled', 'failed')
      AND campaign.recipient_history_purged_at IS NULL
      AND COALESCE(campaign.completed_at, campaign.updated_at, campaign.created_at) < NOW() - retention
      AND NOT EXISTS (
          SELECT 1 FROM public.campaign_recipients AS recipient
          WHERE recipient.campaign_id = campaign.id
      )
      AND NOT EXISTS (
          SELECT 1 FROM public.campaign_delivery_failures AS failure
          WHERE failure.campaign_id = campaign.id
      );

    RETURN v_queue_deleted + v_failures_deleted;
END;
$$;

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
              p_due_at IS NULL
              OR (p_include_unscheduled AND recipient.scheduled_at IS NULL AND recipient.next_scheduled_at IS NULL)
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
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_campaign_recipient(
    p_campaign_id UUID,
    p_contact_id UUID,
    p_claim_token UUID,
    p_success BOOLEAN,
    p_error_message TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_loop BOOLEAN;
    v_recurrence TEXT;
    v_matched BOOLEAN := FALSE;
BEGIN
    SELECT campaign.is_loop, COALESCE(campaign.recurrence, 'none')
    INTO v_is_loop, v_recurrence
    FROM public.campaigns AS campaign
    WHERE campaign.id = p_campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    IF COALESCE(v_is_loop, FALSE) OR v_recurrence <> 'none' THEN
        UPDATE public.campaign_recipients AS recipient
        SET status = CASE WHEN p_success THEN 'sent' ELSE 'failed' END,
            sent_at = CASE WHEN p_success THEN NOW() ELSE recipient.sent_at END,
            error_message = CASE WHEN p_success THEN NULL ELSE COALESCE(NULLIF(p_error_message, ''), 'Unknown delivery error') END,
            claim_token = NULL,
            claimed_at = NULL
        WHERE recipient.campaign_id = p_campaign_id
          AND recipient.contact_id = p_contact_id
          AND recipient.status = 'processing'
          AND recipient.claim_token = p_claim_token;
        v_matched := FOUND;
    ELSE
        DELETE FROM public.campaign_recipients AS recipient
        WHERE recipient.campaign_id = p_campaign_id
          AND recipient.contact_id = p_contact_id
          AND recipient.status = 'processing'
          AND recipient.claim_token = p_claim_token;
        v_matched := FOUND;

        IF v_matched AND NOT p_success THEN
            INSERT INTO public.campaign_delivery_failures (
                campaign_id,
                contact_id,
                error_message,
                failed_at,
                attempt_count
            ) VALUES (
                p_campaign_id,
                p_contact_id,
                COALESCE(NULLIF(p_error_message, ''), 'Unknown delivery error'),
                NOW(),
                1
            )
            ON CONFLICT (campaign_id, contact_id) DO UPDATE
            SET error_message = EXCLUDED.error_message,
                failed_at = EXCLUDED.failed_at,
                attempt_count = LEAST(32767, public.campaign_delivery_failures.attempt_count + 1);
        END IF;
    END IF;

    IF v_matched THEN
        UPDATE public.campaigns AS campaign
        SET sent_count = campaign.sent_count + CASE WHEN p_success THEN 1 ELSE 0 END,
            failed_count = campaign.failed_count + CASE WHEN p_success THEN 0 ELSE 1 END,
            updated_at = NOW()
        WHERE campaign.id = p_campaign_id;
    END IF;

    RETURN v_matched;
END;
$$;

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
        COUNT(recipient.contact_id)::BIGINT
    FROM public.campaigns AS campaign
    LEFT JOIN public.campaign_recipients AS recipient
      ON recipient.campaign_id = campaign.id
     AND recipient.status IN ('pending', 'processing')
    WHERE campaign.id = p_campaign_id
    GROUP BY campaign.id, campaign.sent_count, campaign.failed_count;
$$;

CREATE OR REPLACE FUNCTION public.finish_campaign_recipient_batch(
    p_campaign_id UUID,
    p_claim_token UUID,
    p_results JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_loop BOOLEAN;
    v_recurrence TEXT;
    v_processed INTEGER := 0;
BEGIN
    IF jsonb_typeof(p_results) <> 'array' OR jsonb_array_length(p_results) > 500 THEN
        RAISE EXCEPTION 'p_results must be an array with at most 500 entries';
    END IF;

    SELECT campaign.is_loop, COALESCE(campaign.recurrence, 'none')
    INTO v_is_loop, v_recurrence
    FROM public.campaigns AS campaign
    WHERE campaign.id = p_campaign_id;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    IF COALESCE(v_is_loop, FALSE) OR v_recurrence <> 'none' THEN
        WITH result_rows AS (
            SELECT result.contact_id, result.success,
                   COALESCE(NULLIF(result.error_message, ''), 'Unknown delivery error') AS error_message
            FROM jsonb_to_recordset(p_results)
                AS result(contact_id UUID, success BOOLEAN, error_message TEXT)
        ),
        finished AS (
            UPDATE public.campaign_recipients AS recipient
            SET status = CASE WHEN result.success THEN 'sent' ELSE 'failed' END,
                sent_at = CASE WHEN result.success THEN NOW() ELSE recipient.sent_at END,
                error_message = CASE WHEN result.success THEN NULL ELSE result.error_message END,
                claim_token = NULL,
                claimed_at = NULL
            FROM result_rows AS result
            WHERE recipient.campaign_id = p_campaign_id
              AND recipient.contact_id = result.contact_id
              AND recipient.status = 'processing'
              AND recipient.claim_token = p_claim_token
            RETURNING recipient.contact_id, result.success, result.error_message
        )
        SELECT COUNT(*)::INTEGER INTO v_processed FROM finished;
    ELSE
        WITH result_rows AS (
            SELECT result.contact_id, result.success,
                   COALESCE(NULLIF(result.error_message, ''), 'Unknown delivery error') AS error_message
            FROM jsonb_to_recordset(p_results)
                AS result(contact_id UUID, success BOOLEAN, error_message TEXT)
        ),
        finished AS (
            DELETE FROM public.campaign_recipients AS recipient
            USING result_rows AS result
            WHERE recipient.campaign_id = p_campaign_id
              AND recipient.contact_id = result.contact_id
              AND recipient.status = 'processing'
              AND recipient.claim_token = p_claim_token
            RETURNING recipient.contact_id, result.success, result.error_message
        ),
        failures AS (
            INSERT INTO public.campaign_delivery_failures (
                campaign_id, contact_id, error_message, failed_at, attempt_count
            )
            SELECT p_campaign_id, finished.contact_id, finished.error_message, NOW(), 1
            FROM finished
            WHERE NOT finished.success
            ON CONFLICT (campaign_id, contact_id) DO UPDATE
            SET error_message = EXCLUDED.error_message,
                failed_at = EXCLUDED.failed_at,
                attempt_count = LEAST(32767, public.campaign_delivery_failures.attempt_count + 1)
            RETURNING 1
        )
        SELECT COUNT(*)::INTEGER INTO v_processed FROM finished;
    END IF;

    WITH result_rows AS (
        SELECT result.success
        FROM jsonb_to_recordset(p_results)
            AS result(contact_id UUID, success BOOLEAN, error_message TEXT)
    )
    UPDATE public.campaigns AS campaign
    SET sent_count = campaign.sent_count + (
            SELECT COUNT(*)::INTEGER FROM result_rows WHERE success
        ),
        failed_count = campaign.failed_count + (
            SELECT COUNT(*)::INTEGER FROM result_rows WHERE NOT success
        ),
        updated_at = NOW()
    WHERE campaign.id = p_campaign_id
      AND v_processed = jsonb_array_length(p_results);

    IF v_processed <> jsonb_array_length(p_results) THEN
        RAISE EXCEPTION 'one or more recipient claims expired before batch completion';
    END IF;

    RETURN v_processed;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_loop_campaign_recipient(
    p_campaign_id UUID,
    p_contact_id UUID,
    p_claim_token UUID,
    p_success BOOLEAN,
    p_next_scheduled_at TIMESTAMPTZ DEFAULT NULL,
    p_error_message TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_matched BOOLEAN := FALSE;
BEGIN
    UPDATE public.campaign_recipients AS recipient
    SET status = CASE WHEN p_success THEN 'pending' ELSE 'failed' END,
        message_sent_count = COALESCE(recipient.message_sent_count, 0) + 1,
        last_contacted_at = CASE WHEN p_success THEN NOW() ELSE recipient.last_contacted_at END,
        next_scheduled_at = CASE WHEN p_success THEN p_next_scheduled_at ELSE recipient.next_scheduled_at END,
        scheduled_at = CASE WHEN p_success THEN NULL ELSE recipient.scheduled_at END,
        error_message = CASE WHEN p_success THEN NULL ELSE COALESCE(NULLIF(p_error_message, ''), 'Unknown delivery error') END,
        claim_token = NULL,
        claimed_at = NULL
    WHERE recipient.campaign_id = p_campaign_id
      AND recipient.contact_id = p_contact_id
      AND recipient.status = 'processing'
      AND recipient.claim_token = p_claim_token;
    v_matched := FOUND;

    RETURN v_matched;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_campaign_delivery(p_campaign_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_deleted INTEGER;
BEGIN
    UPDATE public.campaigns AS campaign
    SET status = 'cancelled',
        updated_at = NOW()
    WHERE campaign.id = p_campaign_id
      AND campaign.status = 'sending';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'campaign is not currently sending';
    END IF;

    DELETE FROM public.campaign_recipients AS recipient
    WHERE recipient.campaign_id = p_campaign_id
      AND recipient.status = 'pending';
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_campaign_recipients(UUID, INTEGER, TIMESTAMPTZ, BOOLEAN, INTERVAL) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_campaign_recipient(UUID, UUID, UUID, BOOLEAN, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_campaign_delivery_progress(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_campaign_recipient_batch(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_loop_campaign_recipient(UUID, UUID, UUID, BOOLEAN, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_campaign_delivery(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.claim_campaign_recipients(UUID, INTEGER, TIMESTAMPTZ, BOOLEAN, INTERVAL) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.finish_campaign_recipient(UUID, UUID, UUID, BOOLEAN, TEXT) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.get_campaign_delivery_progress(UUID) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.finish_campaign_recipient_batch(UUID, UUID, JSONB) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.finish_loop_campaign_recipient(UUID, UUID, UUID, BOOLEAN, TIMESTAMPTZ, TEXT) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_campaign_delivery(UUID) TO postgres, service_role;
GRANT ALL ON public.campaign_delivery_failures TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260808_006', 'Atomic compact campaign delivery queue preparation')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';
