-- Scan every Messenger folder with an atomic, resumable contact checkpoint.
BEGIN;
CREATE TABLE IF NOT EXISTS public.page_contact_imports (
    page_id UUID PRIMARY KEY REFERENCES public.pages(id) ON DELETE CASCADE,
    run_id UUID NOT NULL DEFAULT gen_random_uuid(),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','blocked')),
    folder TEXT NOT NULL DEFAULT 'inbox' CHECK (folder IN ('inbox','other','page_done','spam')),
    cursor TEXT,
    processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count>=0),
    auto_tag BOOLEAN NOT NULL DEFAULT TRUE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempted_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    retry_after TIMESTAMPTZ,
    last_error TEXT,
    lease_owner UUID,
    lease_until TIMESTAMPTZ
);
ALTER TABLE public.page_contact_imports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.page_contact_imports FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.page_contact_imports TO service_role;

CREATE OR REPLACE FUNCTION public.request_contact_import(p_page_id UUID,p_run_id UUID,p_auto_tag BOOLEAN DEFAULT TRUE)
RETURNS SETOF public.page_contact_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_job page_contact_imports%ROWTYPE;
BEGIN
    INSERT INTO page_contact_imports(page_id,run_id,auto_tag) VALUES(p_page_id,COALESCE(p_run_id,gen_random_uuid()),p_auto_tag)
    ON CONFLICT(page_id) DO NOTHING;
    SELECT * INTO v_job FROM page_contact_imports WHERE page_id=p_page_id FOR UPDATE;
    -- Attach to an unfinished import. A retried final request with the same
    -- run ID returns its completed state instead of restarting from page one.
    IF v_job.status IN ('completed','blocked') AND v_job.run_id IS DISTINCT FROM p_run_id THEN
        UPDATE page_contact_imports SET run_id=COALESCE(p_run_id,gen_random_uuid()),status='queued',folder='inbox',cursor=NULL,
            processed_count=0,auto_tag=p_auto_tag,started_at=now(),attempted_at=NULL,completed_at=NULL,
            retry_after=NULL,last_error=NULL,lease_owner=NULL,lease_until=NULL WHERE page_id=p_page_id;
    END IF;
    RETURN QUERY SELECT * FROM page_contact_imports WHERE page_id=p_page_id;
END $$;

CREATE OR REPLACE FUNCTION public.claim_contact_import(p_owner UUID,p_page_id UUID DEFAULT NULL)
RETURNS TABLE(page_id UUID,run_id UUID,folder TEXT,cursor TEXT,processed_count INTEGER,auto_tag BOOLEAN,
    started_at TIMESTAMPTZ,fb_page_id TEXT,access_token TEXT,messaging_auto_tag_enabled BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_job page_contact_imports%ROWTYPE;
BEGIN
    IF p_owner IS NULL THEN RAISE EXCEPTION 'A worker owner is required'; END IF;
    IF p_page_id IS NULL THEN
        INSERT INTO page_contact_imports(page_id) SELECT p.id FROM pages p
        ON CONFLICT DO NOTHING;
        UPDATE page_contact_imports SET run_id=gen_random_uuid(),status='queued',folder='inbox',cursor=NULL,
            processed_count=0,auto_tag=TRUE,started_at=now(),completed_at=NULL,retry_after=NULL,last_error=NULL
        WHERE status='completed' AND completed_at<now()-interval '1 day';
    END IF;
    SELECT j.* INTO v_job FROM page_contact_imports j
    WHERE (p_page_id IS NULL OR j.page_id=p_page_id) AND j.status IN ('queued','running')
        AND (j.retry_after IS NULL OR j.retry_after<=now()) AND (j.lease_until IS NULL OR j.lease_until<=now())
        AND NOT EXISTS(SELECT 1 FROM page_sync_leases l WHERE l.page_id=j.page_id AND l.expires_at>now())
    ORDER BY j.attempted_at NULLS FIRST,j.page_id FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN; END IF;
    IF NOT acquire_page_sync_lease(v_job.page_id,p_owner::text,120) THEN RETURN; END IF;
    UPDATE page_contact_imports j SET status='running',attempted_at=now(),lease_owner=p_owner,lease_until=now()+interval '2 minutes'
    WHERE j.page_id=v_job.page_id;
    RETURN QUERY SELECT j.page_id,j.run_id,j.folder,j.cursor,j.processed_count,j.auto_tag,j.started_at,
        p.fb_page_id,p.access_token,p.messaging_auto_tag_enabled
    FROM page_contact_imports j JOIN pages p ON p.id=j.page_id WHERE j.page_id=v_job.page_id;
END $$;

CREATE OR REPLACE FUNCTION public.finish_contact_import_slice(p_page_id UUID,p_owner UUID,p_contacts JSONB,
    p_next_cursor TEXT,p_next_folder TEXT)
RETURNS SETOF public.page_contact_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_job page_contact_imports%ROWTYPE; v_count INTEGER;
BEGIN
    SELECT * INTO v_job FROM page_contact_imports WHERE page_id=p_page_id FOR UPDATE;
    IF NOT FOUND OR v_job.lease_owner IS DISTINCT FROM p_owner OR v_job.lease_until<=now() THEN
        RAISE EXCEPTION 'Import lease expired; retry the current checkpoint' USING ERRCODE='40001';
    END IF;
    IF p_contacts IS NULL OR jsonb_typeof(p_contacts)<>'array' OR jsonb_array_length(p_contacts)>500 THEN
        RAISE EXCEPTION 'Expected at most 500 contacts' USING ERRCODE='22023';
    END IF;
    IF p_next_folder IS NOT NULL AND p_next_folder NOT IN ('inbox','other','page_done','spam') THEN
        RAISE EXCEPTION 'Invalid Messenger folder' USING ERRCODE='22023';
    END IF;
    IF p_next_cursor IS NOT NULL AND (p_next_folder IS DISTINCT FROM v_job.folder OR p_next_cursor IS NOT DISTINCT FROM v_job.cursor) THEN
        RAISE EXCEPTION 'Invalid or repeated contact continuation' USING ERRCODE='22023';
    END IF;
    IF p_next_cursor IS NULL AND p_next_folder IS DISTINCT FROM (CASE v_job.folder
        WHEN 'inbox' THEN 'other' WHEN 'other' THEN 'page_done' WHEN 'page_done' THEN 'spam' ELSE NULL END) THEN
        RAISE EXCEPTION 'Messenger folders must be completed in order' USING ERRCODE='22023';
    END IF;
    INSERT INTO contacts AS existing(page_id,psid,name,last_interaction_at,last_inbound_at,
        best_contact_hour,best_contact_confidence,best_contact_hours,interaction_count,updated_at)
    SELECT p_page_id,r.psid,r.name,r.last_interaction_at,r.last_inbound_at,r.best_contact_hour,
        CASE WHEN r.best_contact_hour IS NULL THEN 'none' ELSE 'inferred' END,
        CASE WHEN r.best_contact_hour IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('hour',r.best_contact_hour,'count',1)) END,
        CASE WHEN r.best_contact_hour IS NULL THEN 0 ELSE 1 END,now()
    FROM jsonb_to_recordset(p_contacts) AS r(psid TEXT,name TEXT,last_interaction_at TIMESTAMPTZ,last_inbound_at TIMESTAMPTZ,best_contact_hour INTEGER)
    ON CONFLICT(page_id,psid) DO UPDATE SET name=COALESCE(EXCLUDED.name,existing.name),
        last_interaction_at=GREATEST(existing.last_interaction_at,EXCLUDED.last_interaction_at),
        last_inbound_at=GREATEST(existing.last_inbound_at,EXCLUDED.last_inbound_at),updated_at=now();
    GET DIAGNOSTICS v_count=ROW_COUNT;
    UPDATE page_contact_imports SET processed_count=processed_count+v_count,
        cursor=p_next_cursor,folder=COALESCE(p_next_folder,folder),
        status=CASE WHEN p_next_folder IS NULL THEN 'completed' ELSE 'queued' END,
        completed_at=CASE WHEN p_next_folder IS NULL THEN now() ELSE NULL END,
        retry_after=NULL,last_error=NULL,lease_owner=NULL,lease_until=NULL WHERE page_id=p_page_id;
    IF p_next_folder IS NULL THEN
        UPDATE pages SET last_synced_at=GREATEST(last_synced_at,v_job.started_at),updated_at=now() WHERE id=p_page_id;
    END IF;
    PERFORM release_page_sync_lease(p_page_id,p_owner::text);
    RETURN QUERY SELECT * FROM page_contact_imports WHERE page_id=p_page_id;
END $$;

REVOKE ALL ON FUNCTION public.request_contact_import(UUID,UUID,BOOLEAN),public.claim_contact_import(UUID,UUID),
    public.finish_contact_import_slice(UUID,UUID,JSONB,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.request_contact_import(UUID,UUID,BOOLEAN),public.claim_contact_import(UUID,UUID),
    public.finish_contact_import_slice(UUID,UUID,JSONB,TEXT,TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.resume_contact_import_on_reconnect()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
    UPDATE page_contact_imports SET run_id=gen_random_uuid(),status='queued',folder='inbox',cursor=NULL,
        processed_count=0,auto_tag=TRUE,started_at=now(),attempted_at=NULL,completed_at=NULL,
        retry_after=NULL,last_error=NULL,lease_owner=NULL,lease_until=NULL
    WHERE page_id=NEW.id AND status='blocked';
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.resume_contact_import_on_reconnect() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS resume_contact_import_on_reconnect ON public.pages;
CREATE TRIGGER resume_contact_import_on_reconnect AFTER UPDATE OF access_token ON public.pages
FOR EACH ROW WHEN (OLD.access_token IS DISTINCT FROM NEW.access_token AND NEW.access_token IS NOT NULL)
EXECUTE FUNCTION public.resume_contact_import_on_reconnect();

INSERT INTO app_private.schema_migrations(version,description) VALUES('20261106_001','Durable imports across all Messenger folders') ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
