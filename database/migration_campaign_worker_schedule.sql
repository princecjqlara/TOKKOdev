-- Deploy the public /api/cron/campaign-scheduled endpoint first.
-- Continue saved campaigns even when the browser or external scheduler stops.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.schedule(
    'tokko-campaign-delivery',
    '* * * * *',
    $worker$
    SELECT net.http_get(
        url := 'https://tokkobeta.vercel.app/api/cron/campaign-scheduled',
        timeout_milliseconds := 30000
    ) AS request_id
    WHERE EXISTS (
        SELECT 1 FROM public.campaigns campaign
        JOIN public.pages page ON page.id = campaign.page_id
        WHERE campaign.is_loop = FALSE
          AND (campaign.next_attempt_at IS NULL OR campaign.next_attempt_at <= NOW())
          AND (page.campaign_delivery_lease_until IS NULL OR page.campaign_delivery_lease_until <= NOW())
          AND (page.campaign_delivery_cooldown_until IS NULL OR page.campaign_delivery_cooldown_until <= NOW())
          AND (
              (campaign.status = 'sending' AND campaign.scheduled_at IS NULL
                  AND campaign.background_delivery_enabled)
              OR (
                  (campaign.status = 'scheduled'
                      OR (campaign.status = 'sending' AND campaign.updated_at <= NOW() - INTERVAL '10 minutes'))
                  AND (
                      campaign.scheduled_at <= NOW()
                      OR EXISTS (
                          SELECT 1 FROM public.campaign_recipients recipient
                          WHERE recipient.campaign_id = campaign.id
                            AND recipient.status IN ('pending', 'processing')
                            AND recipient.scheduled_at <= NOW()
                      )
                  )
              )
          )
    );
    $worker$
);

INSERT INTO app_private.schema_migrations(version, description)
VALUES ('20261109_001', 'Continue queued campaigns through the database scheduler without worker credentials')
ON CONFLICT(version) DO NOTHING;
COMMIT;
