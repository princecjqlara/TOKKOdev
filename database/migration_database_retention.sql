-- Keep the Supabase Free Plan database below its size quota.
--
-- Campaign-level totals remain in `campaigns`. Only recipient-level delivery
-- detail is removed after a terminal campaign has been finished for one day.
-- Draft, scheduled, sending, and looping campaigns are never touched.

ALTER TABLE campaigns
ADD COLUMN IF NOT EXISTS recipient_history_purged_at TIMESTAMPTZ;

-- These indexes duplicate indexes that PostgreSQL already maintains for the
-- UNIQUE constraints. Removing them reduces both storage and write overhead.
DROP INDEX IF EXISTS idx_campaign_recipients_campaign_id;
DROP INDEX IF EXISTS idx_contacts_page_psid;

-- These contact indexes are covered by the leading columns of the UNIQUE
-- (page_id, psid) index used by every PSID lookup in the application.
DROP INDEX IF EXISTS idx_contacts_page_id;
DROP INDEX IF EXISTS idx_contacts_psid;

-- Run one bounded batch at a time so scheduled maintenance does not hold a
-- large delete transaction open. Repeated calls drain any backlog.
CREATE OR REPLACE FUNCTION public.cleanup_terminal_campaign_recipients(
    retention INTERVAL DEFAULT INTERVAL '1 day',
    batch_size INTEGER DEFAULT 50000
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    IF retention < INTERVAL '1 day' THEN
        RAISE EXCEPTION 'retention must be at least 1 day';
    END IF;

    IF batch_size < 1 OR batch_size > 100000 THEN
        RAISE EXCEPTION 'batch_size must be between 1 and 100000';
    END IF;

    WITH doomed AS (
        SELECT recipient.ctid
        FROM public.campaign_recipients AS recipient
        INNER JOIN public.campaigns AS campaign
            ON campaign.id = recipient.campaign_id
        WHERE campaign.status IN ('completed', 'cancelled', 'failed')
          AND COALESCE(
              campaign.completed_at,
              campaign.updated_at,
              campaign.created_at
          ) < NOW() - retention
        LIMIT batch_size
    )
    DELETE FROM public.campaign_recipients AS recipient
    USING doomed
    WHERE recipient.ctid = doomed.ctid;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    UPDATE public.campaigns AS campaign
    SET recipient_history_purged_at = NOW()
    WHERE campaign.status IN ('completed', 'cancelled', 'failed')
      AND campaign.recipient_history_purged_at IS NULL
      AND COALESCE(
          campaign.completed_at,
          campaign.updated_at,
          campaign.created_at
      ) < NOW() - retention
      AND NOT EXISTS (
          SELECT 1
          FROM public.campaign_recipients AS recipient
          WHERE recipient.campaign_id = campaign.id
      );

    RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_terminal_campaign_recipients(INTERVAL, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_terminal_campaign_recipients(INTERVAL, INTEGER) TO postgres;

-- Supabase Cron is backed by pg_cron. The hourly job is deliberately offset
-- from the application's minute-based sending jobs.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

DO $$
DECLARE
    existing_job_id BIGINT;
BEGIN
    SELECT jobid
    INTO existing_job_id
    FROM cron.job
    WHERE jobname = 'tokko-database-retention';

    IF existing_job_id IS NOT NULL THEN
        PERFORM cron.unschedule(existing_job_id);
    END IF;

    PERFORM cron.schedule(
        'tokko-database-retention',
        '17 * * * *',
        'SELECT public.cleanup_terminal_campaign_recipients(INTERVAL ''1 day'', 50000);'
    );
END;
$$;

-- Encourage frequent reuse of dead space in the application's highest-churn
-- tables between physical compactions.
ALTER TABLE campaign_recipients SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_vacuum_threshold = 1000,
    autovacuum_analyze_scale_factor = 0.01
);

ALTER TABLE contacts SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_vacuum_threshold = 500,
    autovacuum_analyze_scale_factor = 0.01
);

ALTER TABLE contact_interactions SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_vacuum_threshold = 1000,
    autovacuum_analyze_scale_factor = 0.02
);
