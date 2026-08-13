-- Keep dynamic audiences and campaign delivery bounded at million-contact scale.
-- Audience rows are inserted directly by PostgreSQL instead of returning every
-- contact UUID to a serverless function.

CREATE OR REPLACE FUNCTION public.materialize_dynamic_campaign_audience(
    p_campaign_id UUID
)
RETURNS TABLE (
    recipient_count BIGINT,
    audience_materialized_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_campaign public.campaigns%ROWTYPE;
    v_recipient_count BIGINT;
    v_materialized_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    SELECT *
    INTO v_campaign
    FROM public.campaigns AS campaign
    WHERE campaign.id = p_campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Campaign not found.' USING ERRCODE = 'P0002';
    END IF;

    IF v_campaign.audience_mode <> 'dynamic' THEN
        RAISE EXCEPTION 'Campaign audience is not dynamic.' USING ERRCODE = '22023';
    END IF;

    IF v_campaign.audience_materialized_at IS NOT NULL THEN
        RETURN QUERY SELECT v_campaign.total_recipients::BIGINT, v_campaign.audience_materialized_at;
        RETURN;
    END IF;

    INSERT INTO public.campaign_recipients (campaign_id, contact_id, status)
    SELECT v_campaign.id, contact.id, 'pending'
    FROM public.contacts AS contact
    WHERE contact.page_id = v_campaign.page_id
      AND contact.psid IS NOT NULL
      AND contact.psid <> ''
      AND (
          v_campaign.audience_start_date IS NULL
          OR COALESCE(contact.first_interaction_at, contact.created_at) >= v_campaign.audience_start_date::TIMESTAMPTZ
      )
      AND (
          COALESCE(jsonb_array_length(v_campaign.audience_include_tag_ids), 0) = 0
          OR EXISTS (
              SELECT 1
              FROM public.contact_tags AS included_tag
              WHERE included_tag.contact_id = contact.id
                AND included_tag.tag_id::TEXT IN (
                    SELECT jsonb_array_elements_text(v_campaign.audience_include_tag_ids)
                )
          )
      )
      AND (
          COALESCE(jsonb_array_length(v_campaign.audience_exclude_tag_ids), 0) = 0
          OR NOT EXISTS (
              SELECT 1
              FROM public.contact_tags AS excluded_tag
              WHERE excluded_tag.contact_id = contact.id
                AND excluded_tag.tag_id::TEXT IN (
                    SELECT jsonb_array_elements_text(v_campaign.audience_exclude_tag_ids)
                )
          )
      )
    ON CONFLICT (campaign_id, contact_id) DO NOTHING;

    SELECT COUNT(*)
    INTO v_recipient_count
    FROM public.campaign_recipients AS recipient
    WHERE recipient.campaign_id = v_campaign.id;

    UPDATE public.campaigns AS campaign
    SET total_recipients = v_recipient_count::INTEGER,
        audience_materialized_at = v_materialized_at,
        updated_at = v_materialized_at
    WHERE campaign.id = v_campaign.id;

    RETURN QUERY SELECT v_recipient_count, v_materialized_at;
END;
$$;

ALTER FUNCTION public.materialize_dynamic_campaign_audience(UUID)
SET statement_timeout = '0';

REVOKE ALL ON FUNCTION public.materialize_dynamic_campaign_audience(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.materialize_dynamic_campaign_audience(UUID) TO service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260813_011', 'Million-contact dynamic audience materialization and send resilience')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';
