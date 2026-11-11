-- Recover existing import/export requests; periodic full-sync creation remains
-- with the primary scheduler. Apply after durable imports and shared quotas.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE OR REPLACE FUNCTION public.claim_contact_import(p_owner UUID,p_page_id UUID DEFAULT NULL)
RETURNS TABLE(page_id UUID,run_id UUID,folder TEXT,cursor TEXT,processed_count INTEGER,auto_tag BOOLEAN,
    started_at TIMESTAMPTZ,fb_page_id TEXT,access_token TEXT,messaging_auto_tag_enabled BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_job public.page_contact_imports%ROWTYPE;
BEGIN
    IF p_owner IS NULL THEN RAISE EXCEPTION 'A worker owner is required'; END IF;
    IF p_page_id IS NULL THEN
        INSERT INTO public.page_contact_imports(page_id) SELECT p.id FROM public.pages p ON CONFLICT DO NOTHING;
        UPDATE public.page_contact_imports SET run_id=gen_random_uuid(),status='queued',folder='inbox',cursor=NULL,
            processed_count=0,auto_tag=TRUE,started_at=now(),completed_at=NULL,retry_after=NULL,last_error=NULL
        WHERE status='completed' AND completed_at<now()-interval '1 day';
    END IF;
    SELECT j.* INTO v_job FROM public.page_contact_imports j JOIN public.pages p ON p.id=j.page_id
    WHERE (p_page_id IS NULL OR j.page_id=p_page_id) AND j.status IN ('queued','running')
      AND (j.retry_after IS NULL OR j.retry_after<=now()) AND (j.lease_until IS NULL OR j.lease_until<=now())
      AND NOT EXISTS(SELECT 1 FROM public.page_sync_leases l WHERE l.page_id=j.page_id AND l.expires_at>now())
      AND (p.campaign_delivery_cooldown_until IS NULL OR p.campaign_delivery_cooldown_until<=NOW())
      AND NOT EXISTS(SELECT 1 FROM app_private.campaign_page_quota_keys(p.id) k
          JOIN app_private.campaign_shared_quota_cooldowns q ON q.scope=k.scope AND q.quota_key=k.quota_key
          WHERE q.retry_at>NOW())
    ORDER BY j.attempted_at NULLS FIRST,j.page_id FOR UPDATE OF j SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN; END IF;
    IF NOT public.acquire_page_sync_lease(v_job.page_id,p_owner::text,120) THEN RETURN; END IF;
    UPDATE public.page_contact_imports j SET status='running',attempted_at=now(),lease_owner=p_owner,lease_until=now()+interval '2 minutes'
    WHERE j.page_id=v_job.page_id;
    RETURN QUERY SELECT j.page_id,j.run_id,j.folder,j.cursor,j.processed_count,j.auto_tag,j.started_at,
        p.fb_page_id,p.access_token,p.messaging_auto_tag_enabled
    FROM public.page_contact_imports j JOIN public.pages p ON p.id=j.page_id WHERE j.page_id=v_job.page_id;
END $$;
REVOKE ALL ON FUNCTION public.claim_contact_import(UUID,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_contact_import(UUID,UUID) TO postgres,service_role;

SELECT cron.schedule('tokko-saved-data-workers','* * * * *',$worker$
    SELECT net.http_get(url := worker.url, timeout_milliseconds := 90000) AS request_id
    FROM (
        SELECT 'https://tokkobeta.vercel.app/api/cron/sync' AS url
        WHERE EXISTS (
            SELECT 1 FROM public.page_contact_imports j JOIN public.pages p ON p.id=j.page_id
            WHERE j.status IN ('queued','running')
              AND (j.attempted_at IS NULL OR j.attempted_at<=NOW()-INTERVAL '5 minutes')
              AND (j.retry_after IS NULL OR j.retry_after<=NOW())
              AND (j.lease_until IS NULL OR j.lease_until<=NOW())
              AND NOT EXISTS(SELECT 1 FROM public.page_sync_leases l WHERE l.page_id=j.page_id AND l.expires_at>NOW())
              AND (p.campaign_delivery_cooldown_until IS NULL OR p.campaign_delivery_cooldown_until<=NOW())
              AND NOT EXISTS(SELECT 1 FROM app_private.campaign_page_quota_keys(p.id) k
                  JOIN app_private.campaign_shared_quota_cooldowns q ON q.scope=k.scope AND q.quota_key=k.quota_key
                  WHERE q.retry_at>NOW())
        )
        UNION ALL
        SELECT 'https://tokkobeta.vercel.app/api/cron/exports'
        WHERE EXISTS (
            SELECT 1 FROM public.conversation_export_jobs j
            WHERE j.expires_at>NOW() AND j.updated_at<=NOW()-INTERVAL '5 minutes'
              AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=NOW())
              AND (j.status='queued' OR (j.status='running'
                  AND (j.claimed_at IS NULL OR j.claimed_at<NOW()-INTERVAL '6 minutes')))
        )
    ) worker;
$worker$);
INSERT INTO app_private.schema_migrations(version,description)
VALUES('20261111_005','Recover saved contact import and conversation export jobs independently of external cron')
ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
