-- Apply after Page worker coordination and campaign shared quotas.
-- The standalone worker only reads Messenger history and saves internal tags.
-- Keep the external follow-up scheduler as the primary poller. Recover Pages
-- it has not attempted for five minutes, with at most three requests per tick.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Requests can arrive from either scheduler. Enforce shared cooldowns at the
-- actual claim too, including Pages connected after a cooldown was recorded.
CREATE OR REPLACE FUNCTION public.claim_messaging_auto_tag_page(p_owner UUID, p_page_id UUID DEFAULT NULL)
RETURNS SETOF public.pages LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id UUID;
BEGIN
    IF p_owner IS NULL THEN RAISE EXCEPTION 'Worker owner is required' USING ERRCODE = '22023'; END IF;
    SELECT p.id INTO v_id FROM public.pages p
    WHERE p.messaging_auto_tag_enabled
      AND (p_page_id IS NULL OR p.id = p_page_id)
      AND (p.messaging_auto_tag_lease_until IS NULL OR p.messaging_auto_tag_lease_until < NOW())
      AND (p.messaging_auto_tag_attempted_at IS NULL OR p.messaging_auto_tag_attempted_at <= NOW() - INTERVAL '1 minute')
      AND (p.campaign_delivery_cooldown_until IS NULL OR p.campaign_delivery_cooldown_until < NOW())
      AND NOT EXISTS (
          SELECT 1 FROM app_private.campaign_page_quota_keys(p.id) key
          JOIN app_private.campaign_shared_quota_cooldowns quota
            ON quota.scope = key.scope AND quota.quota_key = key.quota_key
          WHERE quota.retry_at > NOW()
      )
      AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.page_id = p.id
          AND c.last_inbound_at >= NOW() - INTERVAL '7 days' AND c.last_inbound_at <= NOW())
    ORDER BY p.messaging_auto_tag_attempted_at NULLS FIRST, p.id
    FOR UPDATE OF p SKIP LOCKED LIMIT 1;
    IF v_id IS NULL THEN RETURN; END IF;
    RETURN QUERY UPDATE public.pages SET messaging_auto_tag_owner = p_owner,
        messaging_auto_tag_lease_until = NOW() + INTERVAL '1 minute', messaging_auto_tag_attempted_at = NOW(),
        messaging_auto_tag_scan_started_at = COALESCE(messaging_auto_tag_scan_started_at,
            CASE WHEN messaging_auto_tag_cursor IS NOT NULL THEN messaging_auto_tag_checked_at ELSE NOW() END)
    WHERE id = v_id RETURNING *;
END; $$;
REVOKE ALL ON FUNCTION public.claim_messaging_auto_tag_page(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_messaging_auto_tag_page(UUID, UUID) TO postgres, service_role;

SELECT cron.schedule(
    'tokko-messaging-auto-tag',
    '* * * * *',
    $worker$
    SELECT net.http_get(
        url := 'https://tokkobeta.vercel.app/api/cron/messaging-auto-tag',
        timeout_milliseconds := 30000
    ) AS request_id
    FROM (
        SELECT page.id
        FROM public.pages page
        WHERE page.messaging_auto_tag_enabled
          AND (page.messaging_auto_tag_attempted_at IS NULL
              OR page.messaging_auto_tag_attempted_at <= NOW() - INTERVAL '5 minutes')
          AND (page.messaging_auto_tag_lease_until IS NULL OR page.messaging_auto_tag_lease_until <= NOW())
          AND (page.campaign_delivery_cooldown_until IS NULL OR page.campaign_delivery_cooldown_until <= NOW())
          AND NOT EXISTS (
              SELECT 1 FROM app_private.campaign_page_quota_keys(page.id) key
              JOIN app_private.campaign_shared_quota_cooldowns quota
                ON quota.scope = key.scope AND quota.quota_key = key.quota_key
              WHERE quota.retry_at > NOW()
          )
          AND EXISTS (
              SELECT 1 FROM public.contacts contact WHERE contact.page_id = page.id
                AND contact.last_inbound_at >= NOW() - INTERVAL '7 days'
                AND contact.last_inbound_at <= NOW()
          )
        ORDER BY page.messaging_auto_tag_attempted_at NULLS FIRST, page.id
        LIMIT 3
    ) due;
    $worker$
);

INSERT INTO app_private.schema_migrations(version, description)
VALUES ('20261111_004', 'Recover enabled Messenger auto-tag polling when the external scheduler stops')
ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst, 'reload schema';
COMMIT;
