-- Slow campaign delivery after repeated Meta throttles and make historical
-- manual holds accurately appear as resumable drafts. No recipients reset.
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
        -- A healthy worker usually releases well before its crash-safety
        -- lease expires. Check again without holding up delivery ten minutes.
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
             WHEN v_page.campaign_delivery_rate_strikes = 1 THEN 2 ELSE 5 END;
END; $$;

-- Old operational holds used a 2099 retry sentinel with status='sending'.
-- Keep them paused, while making the existing Continue Unsent action usable.
UPDATE public.campaigns
SET status = 'draft', next_attempt_at = NULL, updated_at = NOW()
WHERE status = 'sending'
  AND NOT background_delivery_enabled
  AND NOT COALESCE(is_loop, FALSE)
  AND scheduled_at IS NULL
  AND next_attempt_at >= TIMESTAMPTZ '2099-01-01'
  AND last_error = 'Paused from automatic continuation so the active 161k campaign can drain; manually resume to re-enable.';

REVOKE ALL ON FUNCTION public.acquire_page_campaign_delivery(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acquire_page_campaign_delivery(UUID, UUID) TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20261026_001', 'Paced campaign recovery and resumable historical manual holds')
ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;
NOTIFY pgrst, 'reload schema';
