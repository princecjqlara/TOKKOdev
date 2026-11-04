-- Keep existing tag IDs and assignments while replacing the two legacy labels.
-- Apply after migration_repair_default_page_tags.sql and worker coordination.
-- Older imports can have the timestamp trigger without its target column,
-- breaking every tag edit, including a default-label repair.
ALTER TABLE public.tags ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE OR REPLACE FUNCTION public.ensure_page_default_tags(p_page_id UUID)
RETURNS SETOF public.tags
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    tag_row public.tags%ROWTYPE;
    required RECORD;
BEGIN
    IF p_page_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.pages WHERE id = p_page_id) THEN
        RAISE EXCEPTION 'Page not found' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('page-default-tags:' || p_page_id, 0));
    FOR required IN SELECT * FROM (VALUES
        ('Qualified', '#2563eb', ARRAY['qualified']),
        ('Not Qualified', '#dc2626', ARRAY['notqualified', 'unqualified']),
        ('Converted', '#16a34a', ARRAY['converted', 'paidavailedservice', 'paidavailedservices']),
        ('Lost', '#6b7280', ARRAY['lost'])
    ) AS defaults(name, color, normalized_names)
    LOOP
        SELECT * INTO tag_row FROM public.tags
        WHERE owner_type = 'page' AND owner_id = p_page_id
          AND regexp_replace(lower(name), '[^a-z]', '', 'g') = ANY(required.normalized_names)
        ORDER BY is_default DESC, (name = required.name) DESC, created_at, id
        LIMIT 1 FOR UPDATE;
        IF NOT FOUND THEN
            INSERT INTO public.tags(name, color, owner_type, owner_id, page_id, is_default)
            VALUES(required.name, required.color, 'page', p_page_id, p_page_id, TRUE)
            RETURNING * INTO tag_row;
        ELSIF tag_row.name IS DISTINCT FROM required.name
           OR tag_row.page_id IS DISTINCT FROM p_page_id OR tag_row.is_default IS DISTINCT FROM TRUE THEN
            UPDATE public.tags SET name = required.name, page_id = p_page_id, is_default = TRUE
            WHERE id = tag_row.id RETURNING * INTO tag_row;
        END IF;
        RETURN NEXT tag_row;
    END LOOP;
END; $$;
REVOKE ALL ON FUNCTION public.ensure_page_default_tags(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_page_default_tags(UUID) TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.create_default_page_tags()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
    PERFORM public.ensure_page_default_tags(NEW.id);
    RETURN NEW;
END; $$;

-- Recheck the recent window once when upgrading the legacy mapping. Reapplying
-- the migration does not keep resetting an active scan.
UPDATE public.pages p SET messaging_auto_tag_checked_at = LEAST(messaging_auto_tag_checked_at, NOW() - INTERVAL '7 days'),
    messaging_auto_tag_cursor = NULL, messaging_auto_tag_scan_started_at = NULL
WHERE EXISTS (SELECT 1 FROM public.tags t WHERE t.owner_type = 'page' AND t.owner_id = p.id
    AND t.is_default AND t.name IN ('Paid / Availed Service', 'Paid / Availed Services', 'Unqualified'));
SELECT count(*) FROM public.pages p CROSS JOIN LATERAL public.ensure_page_default_tags(p.id);

CREATE OR REPLACE FUNCTION public.claim_messaging_auto_tag_page(p_owner UUID, p_page_id UUID DEFAULT NULL)
RETURNS SETOF public.pages LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id UUID;
BEGIN
    IF p_owner IS NULL THEN RAISE EXCEPTION 'Worker owner is required' USING ERRCODE = '22023'; END IF;
    SELECT p.id INTO v_id FROM public.pages p
    WHERE p.messaging_auto_tag_enabled
      AND (p_page_id IS NULL OR p.id = p_page_id)
      AND (p.messaging_auto_tag_lease_until IS NULL OR p.messaging_auto_tag_lease_until < NOW())
      AND (p.messaging_auto_tag_attempted_at IS NULL OR p.messaging_auto_tag_attempted_at <= NOW() - INTERVAL '1 minute')
      AND (p.campaign_delivery_cooldown_until IS NULL OR p.campaign_delivery_cooldown_until < NOW())
      AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.page_id = p.id
          AND c.last_inbound_at >= NOW() - INTERVAL '7 days' AND c.last_inbound_at <= NOW())
    ORDER BY p.messaging_auto_tag_attempted_at NULLS FIRST, p.id
    FOR UPDATE OF p SKIP LOCKED LIMIT 1;
    IF v_id IS NULL THEN RETURN; END IF;
    RETURN QUERY UPDATE public.pages SET messaging_auto_tag_owner = p_owner,
        messaging_auto_tag_lease_until = NOW() + INTERVAL '1 minute', messaging_auto_tag_attempted_at = NOW(),
        messaging_auto_tag_scan_started_at = COALESCE(messaging_auto_tag_scan_started_at,
            CASE WHEN messaging_auto_tag_cursor IS NOT NULL THEN messaging_auto_tag_checked_at ELSE NOW() END)
    WHERE id = v_id RETURNING *;
END; $$;
REVOKE ALL ON FUNCTION public.claim_messaging_auto_tag_page(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_messaging_auto_tag_page(UUID, UUID) TO postgres, service_role;
NOTIFY pgrst, 'reload schema';
