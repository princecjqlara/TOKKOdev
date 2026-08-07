-- Compact raw interaction events into bounded per-contact/hour counters.
--
-- The compatibility view preserves the existing `contact_interactions` API:
-- current application reads still see one logical row per interaction, and
-- inserts are atomically folded into the aggregate table by a view trigger.

CREATE TABLE IF NOT EXISTS app_private.contact_interaction_hourly_stats (
    contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    hour_of_day SMALLINT NOT NULL CHECK (hour_of_day BETWEEN 0 AND 23),
    is_from_contact BOOLEAN NOT NULL DEFAULT TRUE,
    interaction_count INTEGER NOT NULL DEFAULT 1 CHECK (interaction_count > 0),
    first_interaction_at TIMESTAMPTZ NOT NULL,
    last_interaction_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (contact_id, page_id, hour_of_day, is_from_contact),
    CHECK (last_interaction_at >= first_interaction_at)
);

CREATE INDEX IF NOT EXISTS idx_contact_interaction_hourly_page_hour
ON app_private.contact_interaction_hourly_stats(
    page_id,
    is_from_contact,
    hour_of_day,
    contact_id
);

INSERT INTO app_private.contact_interaction_hourly_stats (
    contact_id,
    page_id,
    hour_of_day,
    is_from_contact,
    interaction_count,
    first_interaction_at,
    last_interaction_at
)
SELECT
    contact_id,
    page_id,
    hour_of_day,
    is_from_contact,
    COUNT(*)::INTEGER,
    MIN(interaction_at),
    MAX(interaction_at)
FROM public.contact_interactions
GROUP BY contact_id, page_id, hour_of_day, is_from_contact
ON CONFLICT (contact_id, page_id, hour_of_day, is_from_contact)
DO UPDATE SET
    interaction_count = EXCLUDED.interaction_count,
    first_interaction_at = EXCLUDED.first_interaction_at,
    last_interaction_at = EXCLUDED.last_interaction_at;

DO $$
DECLARE
    raw_count BIGINT;
    aggregate_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO raw_count
    FROM public.contact_interactions;

    SELECT COALESCE(SUM(interaction_count), 0) INTO aggregate_count
    FROM app_private.contact_interaction_hourly_stats;

    IF raw_count <> aggregate_count THEN
        RAISE EXCEPTION
            'Interaction compaction count mismatch: raw %, aggregate %',
            raw_count,
            aggregate_count;
    END IF;
END;
$$;

ALTER TABLE public.contact_interactions
RENAME TO contact_interactions_raw_archive;

CREATE VIEW public.contact_interactions AS
SELECT
    NULL::UUID AS id,
    stats.contact_id,
    stats.page_id,
    stats.last_interaction_at AS interaction_at,
    stats.hour_of_day::INTEGER AS hour_of_day,
    EXTRACT(
        DOW FROM stats.last_interaction_at AT TIME ZONE 'Asia/Manila'
    )::INTEGER AS day_of_week,
    stats.is_from_contact,
    stats.first_interaction_at AS created_at
FROM app_private.contact_interaction_hourly_stats AS stats
CROSS JOIN LATERAL generate_series(1, stats.interaction_count) AS occurrence(number);

CREATE OR REPLACE FUNCTION app_private.record_contact_interaction_from_view()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
    recorded_at TIMESTAMPTZ;
BEGIN
    recorded_at := COALESCE(NEW.interaction_at, NOW());

    INSERT INTO app_private.contact_interaction_hourly_stats (
        contact_id,
        page_id,
        hour_of_day,
        is_from_contact,
        interaction_count,
        first_interaction_at,
        last_interaction_at
    ) VALUES (
        NEW.contact_id,
        NEW.page_id,
        NEW.hour_of_day,
        COALESCE(NEW.is_from_contact, TRUE),
        1,
        recorded_at,
        recorded_at
    )
    ON CONFLICT (contact_id, page_id, hour_of_day, is_from_contact)
    DO UPDATE SET
        interaction_count = app_private.contact_interaction_hourly_stats.interaction_count + 1,
        first_interaction_at = LEAST(
            app_private.contact_interaction_hourly_stats.first_interaction_at,
            EXCLUDED.first_interaction_at
        ),
        last_interaction_at = GREATEST(
            app_private.contact_interaction_hourly_stats.last_interaction_at,
            EXCLUDED.last_interaction_at
        );

    NEW.interaction_at := recorded_at;
    NEW.is_from_contact := COALESCE(NEW.is_from_contact, TRUE);
    NEW.created_at := COALESCE(NEW.created_at, recorded_at);
    RETURN NEW;
END;
$$;

CREATE TRIGGER record_contact_interaction
INSTEAD OF INSERT ON public.contact_interactions
FOR EACH ROW EXECUTE FUNCTION app_private.record_contact_interaction_from_view();

REVOKE ALL ON app_private.contact_interaction_hourly_stats FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.record_contact_interaction_from_view() FROM PUBLIC, anon, authenticated;
GRANT ALL ON app_private.contact_interaction_hourly_stats TO postgres;
GRANT EXECUTE ON FUNCTION app_private.record_contact_interaction_from_view() TO postgres;

REVOKE ALL ON public.contact_interactions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.contact_interactions TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260808_004', 'Compact contact interactions into hourly counters')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';
