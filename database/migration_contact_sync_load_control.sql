-- Prevent concurrent full contact syncs for one page and speed up the default
-- paginated contacts query used while sync/webhook writes are active.

CREATE TABLE IF NOT EXISTS public.page_sync_leases (
    page_id UUID PRIMARY KEY REFERENCES public.pages(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION public.acquire_page_sync_lease(
    p_page_id UUID,
    p_owner TEXT,
    p_lease_seconds INTEGER DEFAULT 360
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    affected_rows INTEGER;
BEGIN
    IF p_owner IS NULL OR btrim(p_owner) = '' THEN
        RAISE EXCEPTION 'p_owner is required';
    END IF;

    IF p_lease_seconds < 60 OR p_lease_seconds > 900 THEN
        RAISE EXCEPTION 'p_lease_seconds must be between 60 and 900';
    END IF;

    INSERT INTO public.page_sync_leases AS lease (
        page_id,
        owner,
        acquired_at,
        expires_at
    )
    VALUES (
        p_page_id,
        p_owner,
        NOW(),
        NOW() + make_interval(secs => p_lease_seconds)
    )
    ON CONFLICT (page_id) DO UPDATE
    SET owner = EXCLUDED.owner,
        acquired_at = CASE
            WHEN lease.owner = EXCLUDED.owner THEN lease.acquired_at
            ELSE NOW()
        END,
        expires_at = EXCLUDED.expires_at
    WHERE lease.owner = EXCLUDED.owner
       OR lease.expires_at <= NOW();

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    RETURN affected_rows = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_page_sync_lease(
    p_page_id UUID,
    p_owner TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    affected_rows INTEGER;
BEGIN
    DELETE FROM public.page_sync_leases
    WHERE page_id = p_page_id
      AND owner = p_owner;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    RETURN affected_rows = 1;
END;
$$;

REVOKE ALL ON TABLE public.page_sync_leases FROM PUBLIC;
REVOKE ALL ON FUNCTION public.acquire_page_sync_lease(UUID, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_page_sync_lease(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acquire_page_sync_lease(UUID, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_page_sync_lease(UUID, TEXT) TO service_role;

CREATE INDEX IF NOT EXISTS idx_contacts_page_last_interaction
ON public.contacts (page_id, last_interaction_at DESC NULLS LAST);

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260813_009', 'Prevent overlapping contact syncs and reduce contacts query load')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';
