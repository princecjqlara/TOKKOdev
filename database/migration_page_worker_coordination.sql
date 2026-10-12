-- Additive coordination for overlapping browser/cron campaign sends and tag scans.
ALTER TABLE public.pages
    ADD COLUMN IF NOT EXISTS campaign_delivery_owner UUID,
    ADD COLUMN IF NOT EXISTS campaign_delivery_lease_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS campaign_delivery_cooldown_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS campaign_delivery_rate_strikes INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS campaign_delivery_last_rate_limit_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS messaging_auto_tag_owner UUID,
    ADD COLUMN IF NOT EXISTS messaging_auto_tag_lease_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS messaging_auto_tag_scan_started_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.acquire_page_campaign_delivery(p_page_id UUID, p_owner UUID)
RETURNS TABLE (acquired BOOLEAN, retry_at TIMESTAMPTZ, batch_size INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_page public.pages%ROWTYPE;
BEGIN
    SELECT * INTO v_page FROM public.pages WHERE id = p_page_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Page not found'; END IF;
    IF v_page.campaign_delivery_cooldown_until > NOW() THEN
        RETURN QUERY SELECT FALSE, v_page.campaign_delivery_cooldown_until, 1; RETURN;
    END IF;
    IF v_page.campaign_delivery_lease_until > NOW() THEN
        RETURN QUERY SELECT FALSE, NOW() + INTERVAL '30 seconds', 1; RETURN;
    END IF;
    IF v_page.campaign_delivery_last_rate_limit_at < NOW() - INTERVAL '6 hours' THEN
        v_page.campaign_delivery_rate_strikes := 0;
    END IF;
    UPDATE public.pages SET campaign_delivery_owner = p_owner,
        campaign_delivery_lease_until = NOW() + INTERVAL '10 minutes',
        campaign_delivery_rate_strikes = v_page.campaign_delivery_rate_strikes
    WHERE id = p_page_id;
    RETURN QUERY SELECT TRUE, NULL::TIMESTAMPTZ,
        CASE WHEN v_page.campaign_delivery_rate_strikes >= 2 THEN 1
             WHEN v_page.campaign_delivery_rate_strikes = 1 THEN 5 ELSE 10 END;
END; $$;

CREATE OR REPLACE FUNCTION public.release_page_campaign_delivery(p_page_id UUID, p_owner UUID, p_rate_limited BOOLEAN DEFAULT FALSE)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_retry TIMESTAMPTZ; v_strikes INTEGER;
BEGIN
    SELECT campaign_delivery_rate_strikes INTO v_strikes FROM public.pages
    WHERE id = p_page_id AND campaign_delivery_owner = p_owner FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF p_rate_limited THEN
        v_strikes := LEAST(v_strikes + 1, 5);
        v_retry := NOW() + MAKE_INTERVAL(mins => LEAST(60, (5 * POWER(2, v_strikes - 1))::INTEGER));
    END IF;
    UPDATE public.pages SET campaign_delivery_owner = NULL, campaign_delivery_lease_until = NULL,
        campaign_delivery_rate_strikes = v_strikes,
        campaign_delivery_cooldown_until = CASE WHEN p_rate_limited THEN v_retry ELSE campaign_delivery_cooldown_until END,
        campaign_delivery_last_rate_limit_at = CASE WHEN p_rate_limited THEN NOW() ELSE campaign_delivery_last_rate_limit_at END
    WHERE id = p_page_id AND campaign_delivery_owner = p_owner;
    IF p_rate_limited THEN
        -- Share the recovery window across campaigns on this Page. Preserve
        -- explicit future holds and never restart a paused/cancelled campaign.
        UPDATE public.campaigns SET next_attempt_at = GREATEST(next_attempt_at, v_retry)
        WHERE page_id = p_page_id AND status IN ('sending', 'scheduled');
    END IF;
    RETURN v_retry;
END; $$;

CREATE OR REPLACE FUNCTION public.claim_messaging_auto_tag_page(p_owner UUID, p_page_id UUID DEFAULT NULL)
RETURNS SETOF public.pages LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
    SELECT id INTO v_id FROM public.pages
    WHERE messaging_auto_tag_enabled
      AND (p_page_id IS NULL OR id = p_page_id)
      AND (messaging_auto_tag_lease_until IS NULL OR messaging_auto_tag_lease_until < NOW())
      AND (campaign_delivery_cooldown_until IS NULL OR campaign_delivery_cooldown_until < NOW())
    ORDER BY messaging_auto_tag_attempted_at NULLS FIRST, id
    FOR UPDATE SKIP LOCKED LIMIT 1;
    IF v_id IS NULL THEN RETURN; END IF;
    RETURN QUERY UPDATE public.pages SET messaging_auto_tag_owner = p_owner,
        messaging_auto_tag_lease_until = NOW() + INTERVAL '1 minute',
        messaging_auto_tag_attempted_at = NOW(),
        messaging_auto_tag_scan_started_at = COALESCE(messaging_auto_tag_scan_started_at,
            CASE WHEN messaging_auto_tag_cursor IS NOT NULL THEN messaging_auto_tag_checked_at ELSE NOW() END)
    WHERE id = v_id RETURNING *;
END; $$;

REVOKE ALL ON FUNCTION public.acquire_page_campaign_delivery(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_page_campaign_delivery(UUID, UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_messaging_auto_tag_page(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acquire_page_campaign_delivery(UUID, UUID) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.release_page_campaign_delivery(UUID, UUID, BOOLEAN) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.claim_messaging_auto_tag_page(UUID, UUID) TO postgres, service_role;
NOTIFY pgrst, 'reload schema';
