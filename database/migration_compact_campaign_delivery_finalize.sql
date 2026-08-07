-- Run only after the RPC-based campaign sender is deployed everywhere.
-- This migration removes completed one-time delivery rows and the redundant
-- per-row UUID. Campaign totals and failure diagnostics remain available.

BEGIN;

-- Preserve every existing failure before removing terminal queue rows.
INSERT INTO public.campaign_delivery_failures (
    campaign_id,
    contact_id,
    error_message,
    failed_at,
    attempt_count
)
SELECT
    recipient.campaign_id,
    recipient.contact_id,
    COALESCE(NULLIF(recipient.error_message, ''), 'Unknown delivery error'),
    COALESCE(recipient.last_contacted_at, recipient.created_at, NOW()),
    1
FROM public.campaign_recipients AS recipient
INNER JOIN public.campaigns AS campaign ON campaign.id = recipient.campaign_id
WHERE recipient.status = 'failed'
  AND NOT COALESCE(campaign.is_loop, FALSE)
  AND COALESCE(campaign.recurrence, 'none') = 'none'
ON CONFLICT (campaign_id, contact_id) DO UPDATE
SET error_message = EXCLUDED.error_message,
    failed_at = EXCLUDED.failed_at;

-- Ensure counters never move backwards if an older sender had not persisted
-- its final batch yet.
WITH terminal_counts AS (
    SELECT
        recipient.campaign_id,
        COUNT(*) FILTER (WHERE recipient.status = 'sent')::INTEGER AS sent_rows,
        COUNT(*) FILTER (WHERE recipient.status = 'failed')::INTEGER AS failed_rows
    FROM public.campaign_recipients AS recipient
    GROUP BY recipient.campaign_id
)
UPDATE public.campaigns AS campaign
SET sent_count = GREATEST(campaign.sent_count, terminal_counts.sent_rows),
    failed_count = GREATEST(campaign.failed_count, terminal_counts.failed_rows)
FROM terminal_counts
WHERE campaign.id = terminal_counts.campaign_id;

DELETE FROM public.campaign_recipients AS recipient
USING public.campaigns AS campaign
WHERE campaign.id = recipient.campaign_id
  AND recipient.status IN ('sent', 'failed')
  AND NOT COALESCE(campaign.is_loop, FALSE)
  AND COALESCE(campaign.recurrence, 'none') = 'none';

COMMIT;

-- Build the replacement key without blocking active inserts. The old unique
-- constraint stays available until the short metadata swap below.
CREATE UNIQUE INDEX CONCURRENTLY campaign_recipients_compact_pkey_idx
    ON public.campaign_recipients(campaign_id, contact_id);

BEGIN;

ALTER TABLE public.campaign_recipients
    DROP CONSTRAINT campaign_recipients_pkey,
    DROP CONSTRAINT campaign_recipients_campaign_id_contact_id_key,
    DROP COLUMN id;

ALTER TABLE public.campaign_recipients
    ADD CONSTRAINT campaign_recipients_pkey
    PRIMARY KEY USING INDEX campaign_recipients_compact_pkey_idx;

COMMIT;

-- This is intentionally outside the transaction. It lets Postgres reuse dead
-- tuples promptly without requiring a long AccessExclusiveLock from VACUUM FULL.
VACUUM (ANALYZE) public.campaign_recipients;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260808_007', 'Finalize compact one-time campaign delivery storage')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';
