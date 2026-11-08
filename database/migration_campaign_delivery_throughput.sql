-- Expand healthy Page capacity while preserving shared leases, cooldowns,
-- and the reduced budgets of Pages recovering from a Meta throttle.
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
        RETURN QUERY SELECT FALSE, LEAST(v_page.campaign_delivery_lease_until, NOW() + INTERVAL '30 seconds'), 1; RETURN;
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
             WHEN v_page.campaign_delivery_rate_strikes = 1 THEN 2 ELSE 25 END;
END; $$;

REVOKE ALL ON FUNCTION public.acquire_page_campaign_delivery(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acquire_page_campaign_delivery(UUID, UUID) TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20261108_001', 'Adaptive high-throughput campaign delivery with retained Meta recovery')
ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;
NOTIFY pgrst, 'reload schema';
