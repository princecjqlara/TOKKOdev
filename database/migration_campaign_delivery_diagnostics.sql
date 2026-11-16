-- Apply after migration_compact_campaign_delivery_prepare.sql and before
-- deploying the delivery-results UI and sender. No recipient data is removed.
BEGIN;

ALTER TABLE public.campaigns
    ADD COLUMN IF NOT EXISTS failure_counts JSONB NOT NULL DEFAULT '{}'::JSONB,
    ADD COLUMN IF NOT EXISTS last_error_diagnostic JSONB;
ALTER TABLE public.campaign_delivery_failures
    ADD COLUMN IF NOT EXISTS diagnostic JSONB;

-- Conservative fallback for receipts from older senders. Bare permission
-- errors must never be counted as blocked recipients or window violations.
CREATE OR REPLACE FUNCTION app_private.classify_delivery_failure(message TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $$
    SELECT CASE
        WHEN message ~* 'another app (is controlling|controls) this thread|pages_utility_messaging|template cannot be found|utility template not|missing utility template|no approved utility templates|not sendable|status is rejected|not allowed in template parameter|unsupported utility template parameter|facebook authorization expired|access token has expired|invalid oauth access token|\(#190\)' THEN 'page_configuration'
        WHEN message ~* 'thread owner has archived or deleted|thread does not exist|error_subcode\s*[:=]\s*2534001' THEN 'conversation_unavailable'
        WHEN message ~* '\(#551\)|isn''t available right now|is not available right now|no matching user found|you cannot send messages to this id' THEN 'recipient_unavailable'
        WHEN message ~* 'outside the allowed window|policy-overview|error_subcode\s*[:=]\s*2018278' THEN 'messaging_policy'
        WHEN message ~* '\(#(4|17|32|341|613)\)|rate limit|too many calls' THEN 'rate_limited'
        WHEN message ~* '\(#(10|2[0-9][0-9])\)' THEN 'page_configuration'
        -- Legacy network/server text lacks provenance; leave it unclassified.
        ELSE 'unknown'
    END;
$$;

-- Retained evidence can be incomplete after cleanup. The UI accounts for the
-- difference between these counts and failed_count as unclassified history.
WITH grouped AS (
    SELECT campaign_id, app_private.classify_delivery_failure(error_message) AS kind, COUNT(*) AS count
    FROM public.campaign_delivery_failures GROUP BY campaign_id, kind
), summaries AS (
    SELECT campaign_id, jsonb_object_agg(kind, count) AS counts FROM grouped GROUP BY campaign_id
)
UPDATE public.campaigns AS campaign SET failure_counts = summaries.counts
FROM summaries WHERE campaign.id = summaries.campaign_id
  AND campaign.failed_count > 0 AND campaign.failure_counts = '{}'::JSONB;

CREATE OR REPLACE FUNCTION app_private.reset_campaign_delivery_diagnostics()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW.failed_count = 0 AND OLD.failed_count <> 0 THEN
        NEW.failure_counts := '{}'::JSONB;
    END IF;
    IF NEW.last_error IS NULL OR
       (NEW.last_error IS DISTINCT FROM OLD.last_error AND NEW.last_error_diagnostic IS NOT DISTINCT FROM OLD.last_error_diagnostic) THEN
        NEW.last_error_diagnostic := NULL;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS reset_campaign_delivery_diagnostics ON public.campaigns;
CREATE TRIGGER reset_campaign_delivery_diagnostics
BEFORE UPDATE OF failed_count, last_error ON public.campaigns
FOR EACH ROW EXECUTE FUNCTION app_private.reset_campaign_delivery_diagnostics();

-- Keep the same claim-token and all-or-nothing completion contract. Additional
-- result metadata is optional, so older senders remain compatible.
CREATE OR REPLACE FUNCTION public.finish_campaign_recipient_batch(
    p_campaign_id UUID, p_claim_token UUID, p_results JSONB
)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_is_loop BOOLEAN;
    v_recurrence TEXT;
    v_processed INTEGER := 0;
BEGIN
    IF p_results IS NULL OR jsonb_typeof(p_results) <> 'array' THEN
        RAISE EXCEPTION 'p_results must be an array with at most 500 entries';
    END IF;
    IF jsonb_array_length(p_results) > 500 THEN
        RAISE EXCEPTION 'p_results must be an array with at most 500 entries';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_results) result
        WHERE jsonb_typeof(result->'success') IS DISTINCT FROM 'boolean') THEN
        RAISE EXCEPTION 'every result must include a boolean success';
    END IF;

    SELECT campaign.is_loop, COALESCE(campaign.recurrence, 'none')
    INTO v_is_loop, v_recurrence FROM public.campaigns AS campaign WHERE campaign.id = p_campaign_id;
    IF NOT FOUND THEN RETURN 0; END IF;

    IF COALESCE(v_is_loop, FALSE) OR v_recurrence <> 'none' THEN
        WITH result_rows AS (
            SELECT result.contact_id, result.success,
                COALESCE(NULLIF(result.error_message, ''), 'Unknown delivery error') AS error_message
            FROM jsonb_to_recordset(p_results) AS result(contact_id UUID, success BOOLEAN, error_message TEXT)
        ), finished AS (
            UPDATE public.campaign_recipients AS recipient
            SET status = CASE WHEN result.success THEN 'sent' ELSE 'failed' END,
                sent_at = CASE WHEN result.success THEN NOW() ELSE recipient.sent_at END,
                error_message = CASE WHEN result.success THEN NULL ELSE result.error_message END,
                claim_token = NULL, claimed_at = NULL
            FROM result_rows AS result WHERE recipient.campaign_id = p_campaign_id
                AND recipient.contact_id = result.contact_id AND recipient.status = 'processing'
                AND recipient.claim_token = p_claim_token
            RETURNING recipient.contact_id
        ) SELECT COUNT(*)::INTEGER INTO v_processed FROM finished;
    ELSE
        WITH result_rows AS (
            SELECT result.contact_id, result.success,
                COALESCE(NULLIF(result.error_message, ''), 'Unknown delivery error') AS error_message,
                result.diagnostic
            FROM jsonb_to_recordset(p_results) AS result(contact_id UUID, success BOOLEAN, error_message TEXT, diagnostic JSONB)
        ), finished AS (
            DELETE FROM public.campaign_recipients AS recipient USING result_rows AS result
            WHERE recipient.campaign_id = p_campaign_id AND recipient.contact_id = result.contact_id
                AND recipient.status = 'processing' AND recipient.claim_token = p_claim_token
            RETURNING recipient.contact_id, result.success, result.error_message, result.diagnostic
        ), failures AS (
            INSERT INTO public.campaign_delivery_failures (campaign_id, contact_id, error_message, diagnostic, failed_at, attempt_count)
            SELECT p_campaign_id, contact_id, error_message, diagnostic, NOW(), 1 FROM finished WHERE NOT success
            ON CONFLICT (campaign_id, contact_id) DO UPDATE SET error_message = EXCLUDED.error_message,
                diagnostic = EXCLUDED.diagnostic, failed_at = EXCLUDED.failed_at,
                attempt_count = LEAST(32767, public.campaign_delivery_failures.attempt_count + 1)
            RETURNING 1
        ) SELECT COUNT(*)::INTEGER INTO v_processed FROM finished;
    END IF;

    IF v_processed <> jsonb_array_length(p_results) THEN
        RAISE EXCEPTION 'one or more recipient claims expired before batch completion';
    END IF;

    -- The existing mirror trigger creates recurring failure rows. Attach the
    -- structured evidence only after every claim has been validated.
    IF COALESCE(v_is_loop, FALSE) OR v_recurrence <> 'none' THEN
        UPDATE public.campaign_delivery_failures failure SET diagnostic = result.diagnostic
        FROM jsonb_to_recordset(p_results) AS result(contact_id UUID, success BOOLEAN, diagnostic JSONB)
        WHERE failure.campaign_id = p_campaign_id AND failure.contact_id = result.contact_id AND NOT result.success;
    END IF;

    WITH result_rows AS (
        SELECT result.success, CASE
            WHEN result.diagnostic->>'kind' IN ('recipient_unavailable', 'conversation_unavailable', 'messaging_policy',
                'page_configuration', 'rate_limited', 'provider_failure', 'transport_failure', 'backend_failure', 'unknown')
            THEN result.diagnostic->>'kind'
            ELSE app_private.classify_delivery_failure(result.error_message) END AS kind
        FROM jsonb_to_recordset(p_results) AS result(success BOOLEAN, error_message TEXT, diagnostic JSONB)
    ), new_counts AS (
        SELECT kind, COUNT(*) AS count FROM result_rows WHERE NOT success GROUP BY kind
    )
    UPDATE public.campaigns AS campaign SET
        sent_count = campaign.sent_count + (SELECT COUNT(*)::INTEGER FROM result_rows WHERE success),
        failed_count = campaign.failed_count + (SELECT COUNT(*)::INTEGER FROM result_rows WHERE NOT success),
        failure_counts = COALESCE((SELECT jsonb_object_agg(kind, count) FROM (
            SELECT kind, SUM(count) AS count FROM (
                SELECT key AS kind, value::BIGINT AS count FROM jsonb_each_text(campaign.failure_counts)
                UNION ALL SELECT kind, count FROM new_counts
            ) combined GROUP BY kind
        ) totals), '{}'::JSONB),
        updated_at = NOW()
    WHERE campaign.id = p_campaign_id;
    RETURN v_processed;
END;
$$;

REVOKE ALL ON FUNCTION app_private.classify_delivery_failure(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.reset_campaign_delivery_diagnostics() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_campaign_recipient_batch(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.classify_delivery_failure(TEXT) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.finish_campaign_recipient_batch(UUID, UUID, JSONB) TO postgres, service_role;

INSERT INTO app_private.schema_migrations(version, description)
VALUES ('20261117_001', 'Durable bulk-send diagnostics and failure category totals')
ON CONFLICT(version) DO UPDATE SET description = EXCLUDED.description;
NOTIFY pgrst, 'reload schema';
COMMIT;
