-- Preserve a campaign's durable recipient queue when a user stops delivery.
-- Successful and failed recipients are already removed from the active queue;
-- pending/processing rows therefore represent exactly the contacts that still
-- need an attempt when the campaign is continued.

CREATE OR REPLACE FUNCTION public.pause_campaign_delivery(p_campaign_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_remaining INTEGER;
BEGIN
    UPDATE public.campaigns AS campaign
    SET status = 'draft',
        background_delivery_enabled = FALSE,
        next_attempt_at = NULL,
        completed_at = NULL,
        last_error = 'Stopped manually. Unsent recipients remain queued.',
        updated_at = NOW()
    WHERE campaign.id = p_campaign_id
      AND campaign.status IN ('sending', 'scheduled');

    IF NOT FOUND THEN
        RAISE EXCEPTION 'campaign is not currently sending';
    END IF;

    SELECT COUNT(*)::INTEGER
    INTO v_remaining
    FROM public.campaign_recipients AS recipient
    WHERE recipient.campaign_id = p_campaign_id
      AND recipient.status IN ('pending', 'processing');

    RETURN COALESCE(v_remaining, 0);
END;
$$;

-- Keep the old RPC name safe for already-deployed clients during rollout.
-- "Cancel" now means a resumable stop and never discards unsent recipients.
CREATE OR REPLACE FUNCTION public.cancel_campaign_delivery(p_campaign_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN public.pause_campaign_delivery(p_campaign_id);
END;
$$;

REVOKE ALL ON FUNCTION public.pause_campaign_delivery(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_campaign_delivery(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pause_campaign_delivery(UUID) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_campaign_delivery(UUID) TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260816_013', 'Preserve unsent campaign recipients across manual stops')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';
