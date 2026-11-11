-- Dispatch a successor after productive slices; the minute cron remains a fallback.
BEGIN;
CREATE TABLE IF NOT EXISTS app_private.campaign_worker_configuration (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
    worker_url TEXT NOT NULL CHECK(worker_url ~ '^https://[^/]+/api/cron/campaign-scheduled$')
);
INSERT INTO app_private.campaign_worker_configuration(singleton,worker_url)
VALUES(TRUE,'https://tokkobeta.vercel.app/api/cron/campaign-scheduled') ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS app_private.campaign_worker_handoffs (
    page_id UUID PRIMARY KEY REFERENCES public.pages(id) ON DELETE CASCADE,
    requested_at TIMESTAMPTZ NOT NULL,
    request_id BIGINT
);
REVOKE ALL ON app_private.campaign_worker_configuration,app_private.campaign_worker_handoffs
    FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.request_campaign_delivery_continuation(p_page_id UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_dispatch BOOLEAN; v_request BIGINT; v_url TEXT;
BEGIN
    -- Deduplicate independent browser/background handoffs for this Page.
    PERFORM pg_advisory_xact_lock(hashtextextended('campaign_handoff:'||p_page_id::TEXT,0));
    IF NOT EXISTS(SELECT 1 FROM public.pages p WHERE p.id=p_page_id
        AND (p.campaign_delivery_lease_until IS NULL OR p.campaign_delivery_lease_until<=NOW())
        AND (p.campaign_delivery_cooldown_until IS NULL OR p.campaign_delivery_cooldown_until<=NOW())) THEN RETURN NULL; END IF;
    IF EXISTS(SELECT 1 FROM app_private.campaign_page_quota_keys(p_page_id) k
        JOIN app_private.campaign_shared_quota_cooldowns q ON q.scope=k.scope AND q.quota_key=k.quota_key
        WHERE q.retry_at>NOW()) THEN RETURN NULL; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.campaigns c WHERE c.page_id=p_page_id AND NOT c.is_loop
        AND (c.next_attempt_at IS NULL OR c.next_attempt_at<=NOW())
        AND c.total_recipients>c.sent_count+c.failed_count
        AND ((c.status='sending' AND c.scheduled_at IS NULL AND c.background_delivery_enabled)
            OR (c.status='scheduled' AND c.scheduled_at<=NOW())
            OR (c.status='scheduled' AND c.scheduled_at IS NULL))
        AND EXISTS(SELECT 1 FROM public.campaign_recipients r WHERE r.campaign_id=c.id
            AND (r.status='pending' OR (r.status='processing' AND r.claimed_at<NOW()-INTERVAL '10 minutes'))
            AND (r.scheduled_at<=NOW() OR (r.scheduled_at IS NULL
                AND (c.scheduled_at<=NOW() OR c.status='sending'))))) THEN RETURN NULL; END IF;
    INSERT INTO app_private.campaign_worker_handoffs(page_id,requested_at)
    VALUES(p_page_id,NOW()) ON CONFLICT(page_id) DO UPDATE SET requested_at=EXCLUDED.requested_at
    WHERE campaign_worker_handoffs.requested_at<=NOW()-INTERVAL '15 seconds'
    RETURNING TRUE INTO v_dispatch;
    IF NOT COALESCE(v_dispatch,FALSE) THEN RETURN NULL; END IF;
    SELECT worker_url INTO v_url FROM app_private.campaign_worker_configuration WHERE singleton;
    IF v_url IS NULL THEN RAISE EXCEPTION 'Campaign worker URL is not configured'; END IF;
    SELECT net.http_get(url:=v_url,timeout_milliseconds:=30000) INTO v_request;
    UPDATE app_private.campaign_worker_handoffs SET request_id=v_request WHERE page_id=p_page_id;
    RETURN v_request;
END; $$;
REVOKE ALL ON FUNCTION public.request_campaign_delivery_continuation(UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.request_campaign_delivery_continuation(UUID) TO postgres,service_role;
INSERT INTO app_private.schema_migrations(version,description)
VALUES('20261111_003','Queue durable successor workers after productive campaign slices')
ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
