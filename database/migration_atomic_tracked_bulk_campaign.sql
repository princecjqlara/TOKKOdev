-- Create large filtered tracked campaigns in one database transaction.
-- This avoids hundreds of PostgREST round trips and guarantees that a
-- campaign cannot survive with only part of its audience materialized.

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
SET search_path = public, pg_temp
AS $$
DECLARE
    v_campaign_id UUID := pg_catalog.gen_random_uuid();
    v_matched_contact_ids UUID[] := ARRAY[]::UUID[];
    v_selected_contact_ids UUID[] := ARRAY[]::UUID[];
    v_total_matched INTEGER := 0;
    v_recipient_count INTEGER := 0;
    v_materialized_at TIMESTAMPTZ := clock_timestamp();
    v_slice_offset INTEGER := GREATEST(COALESCE(p_slice_offset, 0), 0);
BEGIN
    IF p_page_id IS NULL OR p_created_by IS NULL THEN
        RAISE EXCEPTION 'Page and creator are required.' USING ERRCODE = '22023';
    END IF;

    IF COALESCE(BTRIM(p_name), '') = '' OR COALESCE(BTRIM(p_message_text), '') = '' THEN
        RAISE EXCEPTION 'Campaign name and message are required.' USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(
        ARRAY_AGG(contact.id ORDER BY contact.last_interaction_at DESC NULLS LAST, contact.id),
        ARRAY[]::UUID[]
    )
    INTO v_matched_contact_ids
    FROM contacts AS contact
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
              FROM contact_tags AS included_tag
              WHERE included_tag.contact_id = contact.id
                AND included_tag.tag_id = ANY(p_include_tag_ids)
          )
      )
      AND (
          COALESCE(CARDINALITY(p_exclude_tag_ids), 0) = 0
          OR NOT EXISTS (
              SELECT 1
              FROM contact_tags AS excluded_tag
              WHERE excluded_tag.contact_id = contact.id
                AND excluded_tag.tag_id = ANY(p_exclude_tag_ids)
          )
      )
      AND (
          COALESCE(CARDINALITY(p_excluded_contact_ids), 0) = 0
          OR contact.id <> ALL(p_excluded_contact_ids)
      )
      AND (
          LOWER(COALESCE(p_date_filter_mode, 'include')) <> 'exclude'
          AND (p_date_from IS NULL OR COALESCE(contact.first_interaction_at, contact.created_at) >= p_date_from::TIMESTAMPTZ)
          AND (p_date_to IS NULL OR COALESCE(contact.first_interaction_at, contact.created_at) < (p_date_to + 1)::TIMESTAMPTZ)
          OR
          LOWER(COALESCE(p_date_filter_mode, 'include')) = 'exclude'
          AND (
              (p_date_from IS NULL AND p_date_to IS NULL)
              OR (p_date_from IS NOT NULL AND COALESCE(contact.first_interaction_at, contact.created_at) < p_date_from::TIMESTAMPTZ)
              OR (p_date_to IS NOT NULL AND COALESCE(contact.first_interaction_at, contact.created_at) >= (p_date_to + 1)::TIMESTAMPTZ)
          )
      );

    v_total_matched := COALESCE(CARDINALITY(v_matched_contact_ids), 0);

    IF p_slice_limit IS NULL THEN
        v_selected_contact_ids := v_matched_contact_ids;
    ELSIF p_slice_limit > 0 AND v_slice_offset < v_total_matched THEN
        v_selected_contact_ids := v_matched_contact_ids[
            (v_slice_offset + 1):LEAST(v_slice_offset + p_slice_limit, v_total_matched)
        ];
    END IF;

    v_recipient_count := COALESCE(CARDINALITY(v_selected_contact_ids), 0);
    IF v_recipient_count = 0 THEN
        RAISE EXCEPTION 'No sendable contacts matched this selection.' USING ERRCODE = '22023';
    END IF;

    INSERT INTO campaigns (
        id,
        page_id,
        name,
        message_text,
        status,
        total_recipients,
        sent_count,
        failed_count,
        created_by,
        audience_mode,
        audience_materialized_at,
        use_best_time,
        is_loop,
        loop_status,
        use_ai_message,
        template_name,
        template_language,
        recurrence,
        created_at,
        updated_at
    ) VALUES (
        v_campaign_id,
        p_page_id,
        BTRIM(p_name),
        p_message_text,
        'draft',
        v_recipient_count,
        0,
        0,
        p_created_by,
        'specific',
        v_materialized_at,
        FALSE,
        FALSE,
        'stopped',
        FALSE,
        NULLIF(BTRIM(p_template_name), ''),
        CASE WHEN NULLIF(BTRIM(p_template_name), '') IS NULL THEN NULL ELSE NULLIF(BTRIM(p_template_language), '') END,
        'none',
        v_materialized_at,
        v_materialized_at
    );

    INSERT INTO campaign_recipients (campaign_id, contact_id, status)
    SELECT v_campaign_id, selected_contact_id, 'pending'
    FROM UNNEST(v_selected_contact_ids) AS selected_contact_id;

    RETURN QUERY
    SELECT v_campaign_id, v_recipient_count, v_total_matched, v_materialized_at;
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

NOTIFY pgrst, 'reload schema';
