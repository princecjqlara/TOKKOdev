-- Run only after the compatibility view has passed live read/insert checks.

DO $$
DECLARE
    archived_count BIGINT;
    aggregate_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO archived_count
    FROM public.contact_interactions_raw_archive;

    SELECT COALESCE(SUM(interaction_count), 0) INTO aggregate_count
    FROM app_private.contact_interaction_hourly_stats;

    -- New webhook events may already have been folded into the aggregate after
    -- stage one, so the aggregate may be larger but must never be smaller.
    IF aggregate_count < archived_count THEN
        RAISE EXCEPTION
            'Cannot finalize interaction compaction: archive %, aggregate %',
            archived_count,
            aggregate_count;
    END IF;
END;
$$;

DROP TABLE public.contact_interactions_raw_archive;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260808_005', 'Remove verified raw contact interaction archive')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;
