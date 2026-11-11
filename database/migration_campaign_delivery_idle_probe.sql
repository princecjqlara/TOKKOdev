-- Resume an idle Page from conservative defaults after old pacing evidence
-- expires. Apply after migration_campaign_delivery_recovery_pace.sql.
BEGIN;
CREATE OR REPLACE FUNCTION public.acquire_page_campaign_delivery(p_page_id UUID, p_owner UUID)
RETURNS TABLE (acquired BOOLEAN, retry_at TIMESTAMPTZ, batch_size INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_page public.pages%ROWTYPE;
    v_probe BOOLEAN;
BEGIN
    SELECT * INTO v_page FROM public.pages WHERE id=p_page_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Page not found'; END IF;
    IF v_page.campaign_delivery_cooldown_until > NOW() THEN
        RETURN QUERY SELECT FALSE,v_page.campaign_delivery_cooldown_until,1; RETURN;
    END IF;
    IF v_page.campaign_delivery_lease_until > NOW() THEN
        RETURN QUERY SELECT FALSE,LEAST(v_page.campaign_delivery_lease_until,NOW()+INTERVAL '30 seconds'),1; RETURN;
    END IF;
    -- Do not change fresh pacing, a recovery hold, or a live worker's budget.
    -- An inherited app cooldown on a Page that has never run is evidence too.
    v_probe := (v_page.campaign_delivery_concurrency<5 OR v_page.campaign_delivery_interval_ms>100)
        AND COALESCE(v_page.campaign_delivery_feedback_at<=NOW()-INTERVAL '30 minutes',TRUE)
        AND COALESCE(v_page.campaign_delivery_last_rate_limit_at<=NOW()-INTERVAL '30 minutes',TRUE)
        AND COALESCE(v_page.campaign_delivery_cooldown_until<=NOW()-INTERVAL '30 minutes',TRUE);
    UPDATE public.pages SET campaign_delivery_owner=p_owner,
        campaign_delivery_lease_until=NOW()+INTERVAL '10 minutes',
        campaign_delivery_concurrency=CASE WHEN v_probe THEN 5 ELSE campaign_delivery_concurrency END,
        campaign_delivery_interval_ms=CASE WHEN v_probe THEN 100 ELSE campaign_delivery_interval_ms END,
        campaign_delivery_feedback_at=CASE WHEN v_probe THEN NOW() ELSE campaign_delivery_feedback_at END,
        campaign_delivery_rate_strikes=CASE WHEN campaign_delivery_last_rate_limit_at<NOW()-INTERVAL '6 hours'
            THEN 0 ELSE campaign_delivery_rate_strikes END
    WHERE id=p_page_id
    RETURNING * INTO v_page;
    RETURN QUERY SELECT TRUE,NULL::TIMESTAMPTZ,GREATEST(1,LEAST(100,v_page.campaign_delivery_concurrency));
END; $$;
REVOKE ALL ON FUNCTION public.acquire_page_campaign_delivery(UUID,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_page_campaign_delivery(UUID,UUID) TO postgres,service_role;
INSERT INTO app_private.schema_migrations(version,description)
VALUES('20261111_001','Probe stale slow Page pacing after thirty idle minutes without clearing cooldowns or leases')
ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
