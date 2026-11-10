-- Retain learned recovery pace across workers and app-wide throttles.
-- Apply after migration_campaign_delivery_adaptive.sql, before the matching sender.
BEGIN;
CREATE OR REPLACE FUNCTION public.report_page_campaign_delivery_feedback(
    p_page_id UUID,p_owner UUID,p_concurrency INTEGER DEFAULT NULL,p_interval_ms INTEGER DEFAULT NULL,
    p_rate_limited BOOLEAN DEFAULT FALSE,p_retry_after_ms INTEGER DEFAULT 0,p_scope TEXT DEFAULT 'page'
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
    v_page public.pages%ROWTYPE;
    v_retry TIMESTAMPTZ;
    v_growth_after TIMESTAMPTZ;
    v_concurrency INTEGER;
    v_interval INTEGER;
    v_max_concurrency INTEGER;
    v_min_interval INTEGER;
BEGIN
    IF p_rate_limited AND p_scope='app' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('campaign_meta_app_cooldown',0));
    END IF;
    SELECT * INTO v_page FROM public.pages WHERE id=p_page_id AND campaign_delivery_owner=p_owner FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('owned',FALSE); END IF;
    v_retry:=v_page.campaign_delivery_cooldown_until;
    IF p_rate_limited THEN
        -- Repeated checkpoint/finalizer reports from one worker are not new
        -- throttles. Preserve its saved window instead of sliding it forward.
        IF p_retry_after_ms>0 THEN
            v_retry:=GREATEST(v_retry,NOW()+MAKE_INTERVAL(secs => LEAST(p_retry_after_ms,86400000)/1000.0));
        ELSIF NOT (v_page.campaign_delivery_feedback_owner IS NOT DISTINCT FROM p_owner
            AND v_page.campaign_delivery_feedback_limited AND COALESCE(v_retry>NOW(),FALSE)) THEN
            v_retry:=GREATEST(v_retry,NOW()+MAKE_INTERVAL(secs =>
                LEAST(3600,60*POWER(2,LEAST(v_page.campaign_delivery_rate_strikes,5)))));
        END IF;
    END IF;
    v_growth_after:=GREATEST(v_page.campaign_delivery_last_rate_limit_at,v_retry)+INTERVAL '10 minutes';
    v_concurrency:=GREATEST(1,LEAST(100,COALESCE(p_concurrency,v_page.campaign_delivery_concurrency)));
    v_interval:=GREATEST(0,LEAST(5000,COALESCE(p_interval_ms,v_page.campaign_delivery_interval_ms)));
    IF v_growth_after>NOW() THEN
        v_max_concurrency:=CASE WHEN v_page.campaign_delivery_rate_strikes>=3 THEN 1 ELSE 5 END;
        v_min_interval:=CASE WHEN v_page.campaign_delivery_rate_strikes>=3 THEN 5000 ELSE 1000 END;
        v_concurrency:=LEAST(v_concurrency,v_page.campaign_delivery_concurrency,v_max_concurrency);
        v_interval:=GREATEST(v_interval,v_page.campaign_delivery_interval_ms,v_min_interval);
    END IF;
    UPDATE public.pages SET
        campaign_delivery_concurrency=v_concurrency,
        campaign_delivery_interval_ms=v_interval,
        campaign_delivery_feedback_owner=CASE WHEN p_concurrency IS NOT NULL THEN p_owner ELSE campaign_delivery_feedback_owner END,
        campaign_delivery_feedback_limited=CASE WHEN p_concurrency IS NOT NULL THEN p_rate_limited ELSE campaign_delivery_feedback_limited END,
        campaign_delivery_feedback_at=CASE WHEN p_concurrency IS NOT NULL THEN NOW() ELSE campaign_delivery_feedback_at END,
        campaign_delivery_cooldown_until=v_retry
    WHERE id=p_page_id;
    IF p_rate_limited THEN
        IF p_scope='app' THEN
            UPDATE public.pages SET campaign_delivery_cooldown_until=GREATEST(campaign_delivery_cooldown_until,v_retry),
                campaign_delivery_concurrency=LEAST(campaign_delivery_concurrency,
                    CASE WHEN campaign_delivery_rate_strikes>=3 THEN 1 ELSE 5 END),
                campaign_delivery_interval_ms=GREATEST(campaign_delivery_interval_ms,
                    CASE WHEN campaign_delivery_rate_strikes>=3 THEN 5000 ELSE 1000 END)
            WHERE id<>p_page_id;
        END IF;
        UPDATE public.campaigns SET next_attempt_at=GREATEST(next_attempt_at,v_retry)
        WHERE (page_id=p_page_id OR p_scope='app') AND status IN ('sending','scheduled');
    END IF;
    RETURN jsonb_build_object('owned',TRUE,'concurrency',v_concurrency,
        'interval_ms',v_interval,'retry_at',v_retry,'growth_after',v_growth_after);
END; $$;
REVOKE ALL ON FUNCTION public.report_page_campaign_delivery_feedback(UUID,UUID,INTEGER,INTEGER,BOOLEAN,INTEGER,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.report_page_campaign_delivery_feedback(UUID,UUID,INTEGER,INTEGER,BOOLEAN,INTEGER,TEXT) TO postgres,service_role;
INSERT INTO app_private.schema_migrations(version,description)
VALUES ('20261110_001','Retain a conservative recovery pace across campaign workers and app-wide throttles')
ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
