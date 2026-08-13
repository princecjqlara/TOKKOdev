-- Scale one-time campaigns to million-contact audiences without moving the
-- complete contact-id set through application memory. Delivery remains a
-- compact, resumable queue and immediate campaigns can be continued by cron.

ALTER TABLE public.campaigns
ADD COLUMN IF NOT EXISTS template_media_header JSONB;

ALTER TABLE public.campaigns
ADD COLUMN IF NOT EXISTS template_media_headers JSONB;

ALTER TABLE public.campaigns
ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

ALTER TABLE public.campaigns
ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_campaigns_immediate_sending
ON public.campaigns (next_attempt_at, updated_at, id)
WHERE status = 'sending'
  AND scheduled_at IS NULL
  AND NOT COALESCE(is_loop, FALSE);

CREATE INDEX IF NOT EXISTS idx_contacts_page_first_interaction
ON public.contacts (page_id, (COALESCE(first_interaction_at, created_at)));

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_contacts_name_trgm
ON public.contacts USING GIN (name extensions.gin_trgm_ops);

-- Replace the array-based implementation. The previous function aggregated
-- every matching UUID into one PostgreSQL array before inserting recipients;
-- this version streams the selected rows directly into the queue.
CREATE OR REPLACE FUNCTION public.create_filtered_tracked_bulk_campaign(
    p_page_id UUID,
    p_created_by UUID,
    p_name TEXT,
    p_message_text TEXT,
    p_template_name TEXT DEFAULT NULL,
    p_template_language TEXT DEFAULT NULL,
    p_search TEXT DEFAULT NULL,
    p_include_tag_ids UUID[] DEFAULT ARRAY[]::UUID[],
    p_exclude_tag_ids UUID[] DEFAULT ARRAY[]::UUID[],
    p_excluded_contact_ids UUID[] DEFAULT ARRAY[]::UUID[],
    p_date_from DATE DEFAULT NULL,
    p_date_to DATE DEFAULT NULL,
    p_date_filter_mode TEXT DEFAULT 'include',
    p_slice_offset INTEGER DEFAULT 0,
    p_slice_limit INTEGER DEFAULT NULL
)
RETURNS TABLE (
    campaign_id UUID,
    recipient_count INTEGER,
    total_matched INTEGER,
    audience_materialized_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp, extensions
AS $$
DECLARE
    v_campaign_id UUID := pg_catalog.gen_random_uuid();
    v_total_matched BIGINT := 0;
    v_recipient_count BIGINT := 0;
    v_materialized_at TIMESTAMPTZ := clock_timestamp();
    v_slice_offset INTEGER := GREATEST(COALESCE(p_slice_offset, 0), 0);
BEGIN
    IF p_page_id IS NULL OR p_created_by IS NULL THEN
        RAISE EXCEPTION 'Page and creator are required.' USING ERRCODE = '22023';
    END IF;

    IF COALESCE(BTRIM(p_name), '') = '' OR COALESCE(BTRIM(p_message_text), '') = '' THEN
        RAISE EXCEPTION 'Campaign name and message are required.' USING ERRCODE = '22023';
    END IF;

    IF p_slice_limit IS NOT NULL AND p_slice_limit < 1 THEN
        RAISE EXCEPTION 'Slice limit must be positive.' USING ERRCODE = '22023';
    END IF;

    SELECT COUNT(*)
    INTO v_total_matched
    FROM public.contacts AS contact
    WHERE contact.page_id = p_page_id
      AND contact.psid IS NOT NULL
      AND contact.psid <> ''
      AND (
          COALESCE(BTRIM(p_search), '') = ''
          OR contact.name ILIKE ('%' || BTRIM(p_search) || '%')
      )
      AND (
          COALESCE(CARDINALITY(p_include_tag_ids), 0) = 0
          OR EXISTS (
              SELECT 1
              FROM public.contact_tags AS included_tag
              WHERE included_tag.contact_id = contact.id
                AND included_tag.tag_id = ANY(p_include_tag_ids)
          )
      )
      AND (
          COALESCE(CARDINALITY(p_exclude_tag_ids), 0) = 0
          OR NOT EXISTS (
              SELECT 1
              FROM public.contact_tags AS excluded_tag
              WHERE excluded_tag.contact_id = contact.id
                AND excluded_tag.tag_id = ANY(p_exclude_tag_ids)
          )
      )
      AND (
          COALESCE(CARDINALITY(p_excluded_contact_ids), 0) = 0
          OR contact.id <> ALL(p_excluded_contact_ids)
      )
      AND (
          (
              LOWER(COALESCE(p_date_filter_mode, 'include')) <> 'exclude'
              AND (p_date_from IS NULL OR COALESCE(contact.first_interaction_at, contact.created_at) >= p_date_from::TIMESTAMPTZ)
              AND (p_date_to IS NULL OR COALESCE(contact.first_interaction_at, contact.created_at) < (p_date_to + 1)::TIMESTAMPTZ)
          )
          OR
          (
              LOWER(COALESCE(p_date_filter_mode, 'include')) = 'exclude'
              AND (
                  (p_date_from IS NULL AND p_date_to IS NULL)
                  OR (p_date_from IS NOT NULL AND COALESCE(contact.first_interaction_at, contact.created_at) < p_date_from::TIMESTAMPTZ)
                  OR (p_date_to IS NOT NULL AND COALESCE(contact.first_interaction_at, contact.created_at) >= (p_date_to + 1)::TIMESTAMPTZ)
              )
          )
      );

    IF v_total_matched = 0 OR v_slice_offset >= v_total_matched THEN
        RAISE EXCEPTION 'No sendable contacts matched this selection.' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.campaigns (
        id, page_id, name, message_text, status, total_recipients,
        sent_count, failed_count, created_by, audience_mode,
        audience_materialized_at, use_best_time, is_loop, loop_status,
        use_ai_message, template_name, template_language, recurrence,
        created_at, updated_at
    ) VALUES (
        v_campaign_id, p_page_id, BTRIM(p_name), p_message_text, 'draft', 0,
        0, 0, p_created_by, 'specific', NULL, FALSE, FALSE, 'stopped', FALSE,
        NULLIF(BTRIM(p_template_name), ''),
        CASE WHEN NULLIF(BTRIM(p_template_name), '') IS NULL THEN NULL ELSE NULLIF(BTRIM(p_template_language), '') END,
        'none', v_materialized_at, v_materialized_at
    );

    INSERT INTO public.campaign_recipients (campaign_id, contact_id, status)
    SELECT v_campaign_id, selected.id, 'pending'
    FROM (
        SELECT contact.id
        FROM public.contacts AS contact
        WHERE contact.page_id = p_page_id
          AND contact.psid IS NOT NULL
          AND contact.psid <> ''
          AND (
              COALESCE(BTRIM(p_search), '') = ''
              OR contact.name ILIKE ('%' || BTRIM(p_search) || '%')
          )
          AND (
              COALESCE(CARDINALITY(p_include_tag_ids), 0) = 0
              OR EXISTS (
                  SELECT 1 FROM public.contact_tags AS included_tag
                  WHERE included_tag.contact_id = contact.id
                    AND included_tag.tag_id = ANY(p_include_tag_ids)
              )
          )
          AND (
              COALESCE(CARDINALITY(p_exclude_tag_ids), 0) = 0
              OR NOT EXISTS (
                  SELECT 1 FROM public.contact_tags AS excluded_tag
                  WHERE excluded_tag.contact_id = contact.id
                    AND excluded_tag.tag_id = ANY(p_exclude_tag_ids)
              )
          )
          AND (
              COALESCE(CARDINALITY(p_excluded_contact_ids), 0) = 0
              OR contact.id <> ALL(p_excluded_contact_ids)
          )
          AND (
              (
                  LOWER(COALESCE(p_date_filter_mode, 'include')) <> 'exclude'
                  AND (p_date_from IS NULL OR COALESCE(contact.first_interaction_at, contact.created_at) >= p_date_from::TIMESTAMPTZ)
                  AND (p_date_to IS NULL OR COALESCE(contact.first_interaction_at, contact.created_at) < (p_date_to + 1)::TIMESTAMPTZ)
              )
              OR
              (
                  LOWER(COALESCE(p_date_filter_mode, 'include')) = 'exclude'
                  AND (
                      (p_date_from IS NULL AND p_date_to IS NULL)
                      OR (p_date_from IS NOT NULL AND COALESCE(contact.first_interaction_at, contact.created_at) < p_date_from::TIMESTAMPTZ)
                      OR (p_date_to IS NOT NULL AND COALESCE(contact.first_interaction_at, contact.created_at) >= (p_date_to + 1)::TIMESTAMPTZ)
                  )
              )
          )
        ORDER BY contact.last_interaction_at DESC NULLS LAST, contact.id
        OFFSET v_slice_offset
        LIMIT p_slice_limit
    ) AS selected;

    GET DIAGNOSTICS v_recipient_count = ROW_COUNT;
    IF v_recipient_count = 0 THEN
        RAISE EXCEPTION 'No sendable contacts matched this selection.' USING ERRCODE = '22023';
    END IF;

    UPDATE public.campaigns AS campaign
    SET total_recipients = v_recipient_count::INTEGER,
        audience_materialized_at = v_materialized_at,
        updated_at = v_materialized_at
    WHERE campaign.id = v_campaign_id;

    RETURN QUERY
    SELECT
        v_campaign_id,
        v_recipient_count::INTEGER,
        v_total_matched::INTEGER,
        v_materialized_at;
END;
$$;

ALTER FUNCTION public.create_filtered_tracked_bulk_campaign(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID[], UUID[], UUID[], DATE, DATE, TEXT, INTEGER, INTEGER
) SET statement_timeout = '0';

REVOKE ALL ON FUNCTION public.create_filtered_tracked_bulk_campaign(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID[], UUID[], UUID[], DATE, DATE, TEXT, INTEGER, INTEGER
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_filtered_tracked_bulk_campaign(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID[], UUID[], UUID[], DATE, DATE, TEXT, INTEGER, INTEGER
) TO service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260813_010', 'Scale materialization and delivery recovery to million-contact campaigns')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';
