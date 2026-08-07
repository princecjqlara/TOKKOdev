-- Production database control plane.
-- Adds schema-version tracking, health snapshots, configurable maintenance,
-- integrity constraints, and the missing scheduled-recipient index.

CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA app_private TO postgres, service_role;

CREATE TABLE IF NOT EXISTS app_private.schema_migrations (
    version TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_private.database_maintenance_config (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    terminal_recipient_retention INTERVAL NOT NULL DEFAULT INTERVAL '1 day'
        CHECK (terminal_recipient_retention >= INTERVAL '1 day'),
    delete_batch_size INTEGER NOT NULL DEFAULT 50000
        CHECK (delete_batch_size BETWEEN 1 AND 100000),
    snapshot_retention INTERVAL NOT NULL DEFAULT INTERVAL '30 days'
        CHECK (snapshot_retention >= INTERVAL '1 day'),
    run_retention INTERVAL NOT NULL DEFAULT INTERVAL '30 days'
        CHECK (run_retention >= INTERVAL '1 day'),
    cron_log_retention INTERVAL NOT NULL DEFAULT INTERVAL '7 days'
        CHECK (cron_log_retention >= INTERVAL '1 day'),
    warning_database_bytes BIGINT NOT NULL DEFAULT 471859200,
    critical_database_bytes BIGINT NOT NULL DEFAULT 513802240,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (warning_database_bytes > 0),
    CHECK (critical_database_bytes > warning_database_bytes)
);

INSERT INTO app_private.database_maintenance_config (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS app_private.database_health_snapshots (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    database_bytes BIGINT NOT NULL,
    public_schema_bytes BIGINT NOT NULL,
    campaign_recipient_bytes BIGINT NOT NULL,
    pending_recipient_count BIGINT NOT NULL,
    dead_tuple_estimate BIGINT NOT NULL,
    health_status TEXT NOT NULL CHECK (health_status IN ('healthy', 'warning', 'critical')),
    largest_relations JSONB NOT NULL DEFAULT '[]'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_database_health_snapshots_captured
ON app_private.database_health_snapshots(captured_at DESC);

CREATE TABLE IF NOT EXISTS app_private.database_maintenance_runs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
    rows_deleted INTEGER NOT NULL DEFAULT 0,
    database_bytes_before BIGINT,
    database_bytes_after BIGINT,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_database_maintenance_runs_started
ON app_private.database_maintenance_runs(started_at DESC);

-- This index was defined in the scheduling migration but absent in production.
-- It stays tiny until recipient-level schedules are used.
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_scheduled
ON public.campaign_recipients(scheduled_at, status)
WHERE scheduled_at IS NOT NULL;

-- Queries always scope recipient status by campaign or a scheduled timestamp,
-- and best-time queries use contact/page/hour. These global indexes add write
-- cost and substantial Free Plan storage without serving those query shapes.
DROP INDEX IF EXISTS public.idx_campaign_recipients_status;
DROP INDEX IF EXISTS public.idx_contact_interactions_day;
DROP INDEX IF EXISTS public.idx_contact_interactions_interaction_at;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'campaign_recipients_status_check'
          AND conrelid = 'public.campaign_recipients'::REGCLASS
    ) THEN
        ALTER TABLE public.campaign_recipients
        ADD CONSTRAINT campaign_recipients_status_check
        CHECK (status IN ('pending', 'sent', 'failed')) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'campaigns_status_check'
          AND conrelid = 'public.campaigns'::REGCLASS
    ) THEN
        ALTER TABLE public.campaigns
        ADD CONSTRAINT campaigns_status_check
        CHECK (status IN ('draft', 'scheduled', 'sending', 'completed', 'cancelled')) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'campaigns_delivery_counts_check'
          AND conrelid = 'public.campaigns'::REGCLASS
    ) THEN
        ALTER TABLE public.campaigns
        ADD CONSTRAINT campaigns_delivery_counts_check
        CHECK (total_recipients >= 0 AND sent_count >= 0 AND failed_count >= 0) NOT VALID;
    END IF;
END;
$$;

ALTER TABLE public.campaign_recipients
VALIDATE CONSTRAINT campaign_recipients_status_check;
ALTER TABLE public.campaigns
VALIDATE CONSTRAINT campaigns_status_check;
ALTER TABLE public.campaigns
VALIDATE CONSTRAINT campaigns_delivery_counts_check;

CREATE OR REPLACE FUNCTION app_private.capture_database_health()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
    config app_private.database_maintenance_config%ROWTYPE;
    snapshot_id BIGINT;
    database_bytes BIGINT;
    public_bytes BIGINT;
    recipient_bytes BIGINT;
    pending_count BIGINT;
    dead_count BIGINT;
    relation_summary JSONB;
    calculated_status TEXT;
BEGIN
    SELECT * INTO STRICT config
    FROM app_private.database_maintenance_config
    WHERE id = 1;

    SELECT pg_database_size(current_database()) INTO database_bytes;

    SELECT COALESCE(SUM(pg_total_relation_size(class.oid)), 0)
    INTO public_bytes
    FROM pg_class AS class
    INNER JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
    WHERE namespace.nspname = 'public'
      AND class.relkind IN ('r', 'm', 'p');

    SELECT pg_total_relation_size('public.campaign_recipients'::REGCLASS)
    INTO recipient_bytes;

    SELECT COUNT(*) INTO pending_count
    FROM public.campaign_recipients
    WHERE status = 'pending';

    SELECT COALESCE(SUM(n_dead_tup), 0) INTO dead_count
    FROM pg_stat_user_tables;

    SELECT COALESCE(JSONB_AGG(TO_JSONB(relation_row)), '[]'::JSONB)
    INTO relation_summary
    FROM (
        SELECT
            schemaname,
            relname,
            pg_total_relation_size(relid) AS total_bytes,
            n_live_tup AS live_tuple_estimate,
            n_dead_tup AS dead_tuple_estimate
        FROM pg_stat_user_tables
        ORDER BY pg_total_relation_size(relid) DESC
        LIMIT 8
    ) AS relation_row;

    calculated_status := CASE
        WHEN database_bytes >= config.critical_database_bytes THEN 'critical'
        WHEN database_bytes >= config.warning_database_bytes THEN 'warning'
        ELSE 'healthy'
    END;

    INSERT INTO app_private.database_health_snapshots (
        database_bytes,
        public_schema_bytes,
        campaign_recipient_bytes,
        pending_recipient_count,
        dead_tuple_estimate,
        health_status,
        largest_relations
    ) VALUES (
        database_bytes,
        public_bytes,
        recipient_bytes,
        pending_count,
        dead_count,
        calculated_status,
        relation_summary
    )
    RETURNING id INTO snapshot_id;

    RETURN snapshot_id;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.run_database_maintenance()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
    config app_private.database_maintenance_config%ROWTYPE;
    run_started_at TIMESTAMPTZ := clock_timestamp();
    bytes_before BIGINT;
    bytes_after BIGINT;
    deleted_count INTEGER := 0;
    snapshot_id BIGINT;
    failure_message TEXT;
BEGIN
    SELECT * INTO STRICT config
    FROM app_private.database_maintenance_config
    WHERE id = 1;

    SELECT pg_database_size(current_database()) INTO bytes_before;

    deleted_count := public.cleanup_terminal_campaign_recipients(
        config.terminal_recipient_retention,
        config.delete_batch_size
    );

    DELETE FROM app_private.database_health_snapshots
    WHERE captured_at < NOW() - config.snapshot_retention;

    DELETE FROM app_private.database_maintenance_runs
    WHERE started_at < NOW() - config.run_retention;

    DELETE FROM cron.job_run_details
    WHERE end_time IS NOT NULL
      AND end_time < NOW() - config.cron_log_retention;

    snapshot_id := app_private.capture_database_health();
    SELECT pg_database_size(current_database()) INTO bytes_after;

    INSERT INTO app_private.database_maintenance_runs (
        started_at,
        status,
        rows_deleted,
        database_bytes_before,
        database_bytes_after
    ) VALUES (
        run_started_at,
        'success',
        deleted_count,
        bytes_before,
        bytes_after
    );

    RETURN JSONB_BUILD_OBJECT(
        'status', 'success',
        'rows_deleted', deleted_count,
        'database_bytes', bytes_after,
        'snapshot_id', snapshot_id
    );
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS failure_message = MESSAGE_TEXT;

    INSERT INTO app_private.database_maintenance_runs (
        started_at,
        status,
        rows_deleted,
        database_bytes_before,
        database_bytes_after,
        error_message
    ) VALUES (
        run_started_at,
        'failed',
        deleted_count,
        bytes_before,
        pg_database_size(current_database()),
        failure_message
    );

    RETURN JSONB_BUILD_OBJECT('status', 'failed', 'error', failure_message);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_database_health()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $$
    SELECT COALESCE(
        (
            SELECT JSONB_BUILD_OBJECT(
                'captured_at', captured_at,
                'database_bytes', database_bytes,
                'public_schema_bytes', public_schema_bytes,
                'campaign_recipient_bytes', campaign_recipient_bytes,
                'pending_recipient_count', pending_recipient_count,
                'dead_tuple_estimate', dead_tuple_estimate,
                'health_status', health_status,
                'largest_relations', largest_relations
            )
            FROM app_private.database_health_snapshots
            ORDER BY captured_at DESC
            LIMIT 1
        ),
        '{}'::JSONB
    );
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM PUBLIC, anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA app_private TO postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA app_private TO postgres;
GRANT EXECUTE ON FUNCTION app_private.capture_database_health() TO postgres;
GRANT EXECUTE ON FUNCTION app_private.run_database_maintenance() TO postgres;
REVOKE ALL ON FUNCTION public.get_database_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_database_health() TO postgres, service_role;

DO $$
DECLARE
    existing_job_id BIGINT;
BEGIN
    FOR existing_job_id IN
        SELECT jobid
        FROM cron.job
        WHERE jobname IN ('tokko-database-retention', 'tokko-database-maintenance')
    LOOP
        PERFORM cron.unschedule(existing_job_id);
    END LOOP;

    PERFORM cron.schedule(
        'tokko-database-maintenance',
        '17 * * * *',
        'SELECT app_private.run_database_maintenance();'
    );
END;
$$;

INSERT INTO app_private.schema_migrations (version, description)
VALUES
    ('20260808_001', 'Database retention and quota recovery'),
    ('20260808_002', 'Follow-up workflow automation schema repair'),
    ('20260808_003', 'Database control plane and health monitoring')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

SELECT app_private.capture_database_health();
NOTIFY pgrst, 'reload schema';
