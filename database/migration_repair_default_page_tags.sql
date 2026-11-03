-- Restore operational Page tags after a data cleanup. Existing tag IDs,
-- assignments, Page tokens and scan checkpoints are preserved.
CREATE OR REPLACE FUNCTION public.ensure_page_default_tags(p_page_id UUID)
RETURNS SETOF public.tags
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    tag_row public.tags%ROWTYPE;
    required RECORD;
BEGIN
    IF p_page_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.pages WHERE id = p_page_id) THEN
        RAISE EXCEPTION 'Page not found' USING ERRCODE = '22023';
    END IF;
    -- Serialize repairs without creating duplicate tags in overlapping workers.
    PERFORM pg_advisory_xact_lock(hashtextextended('page-default-tags:' || p_page_id, 0));
    FOR required IN SELECT * FROM (VALUES
        ('Paid / Availed Service', '#16a34a', ARRAY['paidavailedservice', 'paidavailedservices']),
        ('Unqualified', '#dc2626', ARRAY['unqualified'])
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
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_page_default_tags(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_page_default_tags(UUID) TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.create_default_page_tags()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
    PERFORM public.ensure_page_default_tags(NEW.id);
    RETURN NEW;
END;
$$;

-- Add only the missing definitions; never backfill contact assignments.
SELECT count(*) FROM public.pages p
CROSS JOIN LATERAL public.ensure_page_default_tags(p.id);

NOTIFY pgrst, 'reload schema';
