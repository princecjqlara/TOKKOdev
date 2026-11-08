-- Persist learned Page speed instead of resetting every worker to a large burst.
BEGIN;
ALTER TABLE public.pages
    ADD COLUMN IF NOT EXISTS campaign_delivery_concurrency INTEGER NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS campaign_delivery_interval_ms INTEGER NOT NULL DEFAULT 100,
    ADD COLUMN IF NOT EXISTS campaign_delivery_feedback_owner UUID,
    ADD COLUMN IF NOT EXISTS campaign_delivery_feedback_limited BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS campaign_delivery_feedback_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.acquire_page_campaign_delivery(p_page_id UUID, p_owner UUID)
RETURNS TABLE (acquired BOOLEAN, retry_at TIMESTAMPTZ, batch_size INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_page public.pages%ROWTYPE;
BEGIN
    SELECT * INTO v_page FROM public.pages WHERE id=p_page_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Page not found'; END IF;
    IF v_page.campaign_delivery_cooldown_until > NOW() THEN
        RETURN QUERY SELECT FALSE,v_page.campaign_delivery_cooldown_until,1; RETURN;
    END IF;
    IF v_page.campaign_delivery_lease_until > NOW() THEN
        RETURN QUERY SELECT FALSE,LEAST(v_page.campaign_delivery_lease_until,NOW()+INTERVAL '30 seconds'),1; RETURN;
    END IF;
    UPDATE public.pages SET campaign_delivery_owner=p_owner,
        campaign_delivery_lease_until=NOW()+INTERVAL '10 minutes',
        campaign_delivery_rate_strikes=CASE WHEN campaign_delivery_last_rate_limit_at<NOW()-INTERVAL '6 hours'
            THEN 0 ELSE campaign_delivery_rate_strikes END
    WHERE id=p_page_id;
    RETURN QUERY SELECT TRUE,NULL::TIMESTAMPTZ,GREATEST(1,LEAST(100,v_page.campaign_delivery_concurrency));
END; $$;

CREATE OR REPLACE FUNCTION public.report_page_campaign_delivery_feedback(
    p_page_id UUID,p_owner UUID,p_concurrency INTEGER DEFAULT NULL,p_interval_ms INTEGER DEFAULT NULL,
    p_rate_limited BOOLEAN DEFAULT FALSE,p_retry_after_ms INTEGER DEFAULT 0,p_scope TEXT DEFAULT 'page'
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_page public.pages%ROWTYPE; v_retry TIMESTAMPTZ;
BEGIN
    IF p_rate_limited AND p_scope='app' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('campaign_meta_app_cooldown',0));
    END IF;
    SELECT * INTO v_page FROM public.pages WHERE id=p_page_id AND campaign_delivery_owner=p_owner FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('owned',FALSE); END IF;
    v_retry:=v_page.campaign_delivery_cooldown_until;
    IF p_rate_limited THEN
        v_retry:=GREATEST(v_retry,NOW()+MAKE_INTERVAL(secs =>
            CASE WHEN p_retry_after_ms>0 THEN LEAST(p_retry_after_ms,86400000)/1000.0
                 ELSE LEAST(3600,60*POWER(2,LEAST(v_page.campaign_delivery_rate_strikes,5))) END));
    END IF;
    UPDATE public.pages SET
        campaign_delivery_concurrency=CASE WHEN v_retry>NOW() AND NOT p_rate_limited
            THEN LEAST(campaign_delivery_concurrency,GREATEST(1,COALESCE(p_concurrency,campaign_delivery_concurrency)))
            ELSE GREATEST(1,LEAST(100,COALESCE(p_concurrency,campaign_delivery_concurrency))) END,
        campaign_delivery_interval_ms=CASE WHEN v_retry>NOW() AND NOT p_rate_limited
            THEN GREATEST(campaign_delivery_interval_ms,LEAST(5000,COALESCE(p_interval_ms,campaign_delivery_interval_ms)))
            ELSE GREATEST(0,LEAST(5000,COALESCE(p_interval_ms,campaign_delivery_interval_ms))) END,
        campaign_delivery_feedback_owner=CASE WHEN p_concurrency IS NOT NULL THEN p_owner ELSE campaign_delivery_feedback_owner END,
        campaign_delivery_feedback_limited=CASE WHEN p_concurrency IS NOT NULL THEN p_rate_limited ELSE campaign_delivery_feedback_limited END,
        campaign_delivery_feedback_at=CASE WHEN p_concurrency IS NOT NULL THEN NOW() ELSE campaign_delivery_feedback_at END,
        campaign_delivery_cooldown_until=v_retry
    WHERE id=p_page_id;
    IF p_rate_limited THEN
        IF p_scope='app' THEN
            UPDATE public.pages SET campaign_delivery_cooldown_until=GREATEST(campaign_delivery_cooldown_until,v_retry),
                campaign_delivery_concurrency=CASE WHEN v_page.campaign_delivery_feedback_owner IS DISTINCT FROM p_owner OR NOT v_page.campaign_delivery_feedback_limited
                    THEN GREATEST(1,campaign_delivery_concurrency/2) ELSE campaign_delivery_concurrency END,
                campaign_delivery_interval_ms=CASE WHEN v_page.campaign_delivery_feedback_owner IS DISTINCT FROM p_owner OR NOT v_page.campaign_delivery_feedback_limited
                    THEN LEAST(5000,GREATEST(100,campaign_delivery_interval_ms*2)) ELSE campaign_delivery_interval_ms END
            WHERE id<>p_page_id;
        END IF;
        UPDATE public.campaigns SET next_attempt_at=GREATEST(next_attempt_at,v_retry)
        WHERE (page_id=p_page_id OR p_scope='app') AND status IN ('sending','scheduled');
    END IF;
    RETURN (SELECT jsonb_build_object('owned',TRUE,'concurrency',campaign_delivery_concurrency,
        'interval_ms',campaign_delivery_interval_ms,'retry_at',campaign_delivery_cooldown_until)
        FROM public.pages WHERE id=p_page_id);
END; $$;

CREATE OR REPLACE FUNCTION public.release_page_campaign_delivery(p_page_id UUID,p_owner UUID,p_rate_limited BOOLEAN DEFAULT FALSE)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_page public.pages%ROWTYPE; v_retry TIMESTAMPTZ; v_strikes INTEGER;
BEGIN
    SELECT * INTO v_page FROM public.pages WHERE id=p_page_id AND campaign_delivery_owner=p_owner FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_strikes:=v_page.campaign_delivery_rate_strikes;
    IF p_rate_limited THEN
        v_strikes:=LEAST(v_strikes+1,5);
        IF v_page.campaign_delivery_feedback_owner=p_owner AND v_page.campaign_delivery_feedback_limited AND v_page.campaign_delivery_cooldown_until>NOW() THEN
            v_retry:=v_page.campaign_delivery_cooldown_until;
        ELSE
            v_retry:=GREATEST(v_page.campaign_delivery_cooldown_until,NOW()+MAKE_INTERVAL(secs => LEAST(3600,60*POWER(2,v_strikes-1))));
            v_page.campaign_delivery_concurrency:=GREATEST(1,v_page.campaign_delivery_concurrency/2);
            v_page.campaign_delivery_interval_ms:=LEAST(5000,GREATEST(100,v_page.campaign_delivery_interval_ms*2));
        END IF;
    END IF;
    UPDATE public.pages SET campaign_delivery_owner=NULL,campaign_delivery_lease_until=NULL,
        campaign_delivery_rate_strikes=v_strikes,
        campaign_delivery_concurrency=v_page.campaign_delivery_concurrency,
        campaign_delivery_interval_ms=v_page.campaign_delivery_interval_ms,
        campaign_delivery_cooldown_until=CASE WHEN p_rate_limited THEN v_retry ELSE campaign_delivery_cooldown_until END,
        campaign_delivery_last_rate_limit_at=CASE WHEN p_rate_limited THEN NOW() ELSE campaign_delivery_last_rate_limit_at END
    WHERE id=p_page_id AND campaign_delivery_owner=p_owner;
    IF p_rate_limited THEN
        UPDATE public.campaigns SET next_attempt_at=GREATEST(next_attempt_at,v_retry)
        WHERE page_id=p_page_id AND status IN ('sending','scheduled');
    END IF;
    RETURN v_retry;
END; $$;

REVOKE ALL ON FUNCTION public.acquire_page_campaign_delivery(UUID,UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.release_page_campaign_delivery(UUID,UUID,BOOLEAN) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.report_page_campaign_delivery_feedback(UUID,UUID,INTEGER,INTEGER,BOOLEAN,INTEGER,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_page_campaign_delivery(UUID,UUID) TO postgres,service_role;
GRANT EXECUTE ON FUNCTION public.release_page_campaign_delivery(UUID,UUID,BOOLEAN) TO postgres,service_role;
GRANT EXECUTE ON FUNCTION public.report_page_campaign_delivery_feedback(UUID,UUID,INTEGER,INTEGER,BOOLEAN,INTEGER,TEXT) TO postgres,service_role;
INSERT INTO app_private.schema_migrations(version,description)
VALUES('20261108_003','Learn Page delivery pace from Meta quota and retry feedback')
ON CONFLICT(version) DO UPDATE SET description=EXCLUDED.description;
NOTIFY pgrst,'reload schema';
COMMIT;
