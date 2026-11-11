-- Verified token-owner and observed business-use-case cooldown groups.
-- Apply after migration_campaign_delivery_idle_probe.sql, before the sender.
BEGIN;
CREATE TABLE IF NOT EXISTS app_private.campaign_page_quota_identity (
    page_id UUID PRIMARY KEY REFERENCES public.pages(id) ON DELETE CASCADE,
    token_fingerprint TEXT NOT NULL CHECK(token_fingerprint ~ '^[a-f0-9]{64}$'),
    facebook_user_id TEXT NOT NULL CHECK(facebook_user_id ~ '^[0-9]+$'),
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaign_quota_user ON app_private.campaign_page_quota_identity(facebook_user_id);
CREATE TABLE IF NOT EXISTS app_private.campaign_page_business_quotas (
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    token_fingerprint TEXT NOT NULL CHECK(token_fingerprint ~ '^[a-f0-9]{64}$'),
    quota_key TEXT NOT NULL CHECK(quota_key ~ '^[0-9]+:(messenger|pages)$'),
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(page_id,quota_key)
);
CREATE INDEX IF NOT EXISTS idx_campaign_quota_business ON app_private.campaign_page_business_quotas(quota_key,observed_at);
CREATE TABLE IF NOT EXISTS app_private.campaign_shared_quota_cooldowns (
    scope TEXT NOT NULL CHECK(scope IN ('app','user','business')),
    quota_key TEXT NOT NULL,
    retry_at TIMESTAMPTZ NOT NULL,
    growth_after TIMESTAMPTZ NOT NULL,
    concurrency INTEGER NOT NULL CHECK(concurrency BETWEEN 1 AND 100),
    interval_ms INTEGER NOT NULL CHECK(interval_ms BETWEEN 0 AND 5000),
    PRIMARY KEY(scope,quota_key)
);
REVOKE ALL ON app_private.campaign_page_quota_identity,app_private.campaign_page_business_quotas,
    app_private.campaign_shared_quota_cooldowns FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.campaign_page_quota_keys(p_page_id UUID)
RETURNS TABLE(scope TEXT,quota_key TEXT) LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=public AS $$
    SELECT 'app'::TEXT,'shared'::TEXT
    UNION ALL
    SELECT 'user',i.facebook_user_id FROM app_private.campaign_page_quota_identity i
    JOIN public.pages p ON p.id=i.page_id
    WHERE p.id=p_page_id AND i.token_fingerprint=ENCODE(SHA256(CONVERT_TO(p.access_token,'UTF8')),'hex')
    UNION ALL
    SELECT 'business',b.quota_key FROM app_private.campaign_page_business_quotas b
    JOIN public.pages p ON p.id=b.page_id
    WHERE p.id=p_page_id AND b.token_fingerprint=ENCODE(SHA256(CONVERT_TO(p.access_token,'UTF8')),'hex')
      AND b.observed_at>=NOW()-INTERVAL '24 hours';
$$;
REVOKE ALL ON FUNCTION app_private.campaign_page_quota_keys(UUID) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.record_page_campaign_quota_identity(
    p_page_id UUID,p_token_fingerprint TEXT,p_facebook_user_id TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('campaign_meta_shared_quota',0));
    IF p_facebook_user_id IS NULL OR p_facebook_user_id !~ '^[0-9]+$' THEN
        RAISE EXCEPTION 'A verified Facebook subject is required';
    END IF;
    PERFORM 1 FROM public.pages WHERE id=p_page_id
        AND ENCODE(SHA256(CONVERT_TO(access_token,'UTF8')),'hex')=p_token_fingerprint FOR UPDATE;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    INSERT INTO app_private.campaign_page_quota_identity(page_id,token_fingerprint,facebook_user_id)
    VALUES(p_page_id,p_token_fingerprint,p_facebook_user_id)
    ON CONFLICT(page_id) DO UPDATE SET token_fingerprint=EXCLUDED.token_fingerprint,
        facebook_user_id=EXCLUDED.facebook_user_id,verified_at=NOW();
    DELETE FROM app_private.campaign_page_business_quotas WHERE page_id=p_page_id AND token_fingerprint<>p_token_fingerprint;
    RETURN TRUE;
END; $$;

-- Preserve the installed local pacing and idle-probe implementations. The new
-- public wrappers add grouping without resetting existing Page state.
DO $$ BEGIN
    IF to_regprocedure('public.report_page_campaign_delivery_feedback_local(uuid,uuid,integer,integer,boolean,integer,text)') IS NULL THEN
        ALTER FUNCTION public.report_page_campaign_delivery_feedback(UUID,UUID,INTEGER,INTEGER,BOOLEAN,INTEGER,TEXT)
            RENAME TO report_page_campaign_delivery_feedback_local;
    END IF;
    IF to_regprocedure('public.acquire_page_campaign_delivery_local(uuid,uuid)') IS NULL THEN
        ALTER FUNCTION public.acquire_page_campaign_delivery(UUID,UUID) RENAME TO acquire_page_campaign_delivery_local;
    END IF;
END; $$;
REVOKE ALL ON FUNCTION public.report_page_campaign_delivery_feedback_local(UUID,UUID,INTEGER,INTEGER,BOOLEAN,INTEGER,TEXT)
    FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.acquire_page_campaign_delivery_local(UUID,UUID) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.report_page_campaign_delivery_feedback(
    p_page_id UUID,p_owner UUID,p_concurrency INTEGER DEFAULT NULL,p_interval_ms INTEGER DEFAULT NULL,
    p_rate_limited BOOLEAN DEFAULT FALSE,p_retry_after_ms INTEGER DEFAULT 0,p_scope TEXT DEFAULT 'page'
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
    v_page public.pages%ROWTYPE;
    v_context JSONB;
    v_scope TEXT;
    v_key TEXT;
    v_fingerprint TEXT;
    v_item TEXT;
    v_target JSONB;
    v_targets JSONB;
    v_target_retry TIMESTAMPTZ;
    v_result JSONB;
    v_retry TIMESTAMPTZ;
    v_growth TIMESTAMPTZ;
    v_concurrency INTEGER;
    v_interval INTEGER;
BEGIN
    -- Shared groups overlap (a user may have Pages in several businesses).
    -- Serialize these short feedback transactions, never outbound API calls.
    PERFORM pg_advisory_xact_lock(hashtextextended('campaign_meta_shared_quota',0));
    SELECT * INTO v_page FROM public.pages WHERE id=p_page_id AND campaign_delivery_owner=p_owner FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('owned',FALSE); END IF;
    v_fingerprint:=ENCODE(SHA256(CONVERT_TO(v_page.access_token,'UTF8')),'hex');
    IF LEFT(COALESCE(p_scope,''),1)='{' THEN v_context:=p_scope::JSONB;
    ELSE v_context:=jsonb_build_object('scope',COALESCE(p_scope,'page')); END IF;
    v_scope:=COALESCE(v_context->>'scope','page');
    IF jsonb_typeof(v_context->'businessKeys')='array' THEN
        FOR v_item IN SELECT jsonb_array_elements_text(v_context->'businessKeys') LIMIT 32 LOOP
            IF v_item ~ '^[0-9]+:(messenger|pages)$' THEN
                INSERT INTO app_private.campaign_page_business_quotas(page_id,token_fingerprint,quota_key)
                VALUES(p_page_id,v_fingerprint,v_item)
                ON CONFLICT(page_id,quota_key) DO UPDATE SET token_fingerprint=EXCLUDED.token_fingerprint,observed_at=NOW();
            END IF;
        END LOOP;
    END IF;
    v_result:=public.report_page_campaign_delivery_feedback_local(p_page_id,p_owner,p_concurrency,p_interval_ms,
        p_rate_limited,p_retry_after_ms,CASE WHEN v_scope='app' THEN 'app' ELSE 'page' END);
    IF NOT COALESCE((v_result->>'owned')::BOOLEAN,FALSE) THEN RETURN v_result; END IF;
    v_retry:=(v_result->>'retry_at')::TIMESTAMPTZ;
    IF p_rate_limited THEN
        v_targets:=jsonb_build_array(jsonb_build_object('scope',v_scope,'key',v_context->>'key'));
        IF jsonb_typeof(v_context->'targets')='array' AND jsonb_array_length(v_context->'targets')>0 THEN
            v_targets:=v_context->'targets';
        END IF;
        FOR v_target IN SELECT value FROM jsonb_array_elements(v_targets) LIMIT 16 LOOP
            v_scope:=v_target->>'scope'; v_key:=NULL;
            IF v_scope='app' THEN v_key:='shared';
            ELSIF v_scope='user' THEN
                SELECT k.quota_key INTO v_key FROM app_private.campaign_page_quota_keys(p_page_id) k WHERE k.scope='user';
            ELSIF v_scope='business' THEN
                SELECT k.quota_key INTO v_key FROM app_private.campaign_page_quota_keys(p_page_id) k
                WHERE k.scope='business' AND k.quota_key=v_target->>'key';
            END IF;
            IF v_key IS NULL THEN CONTINUE; END IF;
            v_target_retry:=v_retry;
            IF v_target->>'retryAfterMs' ~ '^[0-9]+$' AND (v_target->>'retryAfterMs')::NUMERIC>0 THEN
                v_target_retry:=NOW()+MAKE_INTERVAL(secs=>LEAST((v_target->>'retryAfterMs')::NUMERIC,86400000)/1000.0);
            END IF;
            INSERT INTO app_private.campaign_shared_quota_cooldowns(scope,quota_key,retry_at,growth_after,concurrency,interval_ms)
            VALUES(v_scope,v_key,v_target_retry,v_target_retry+INTERVAL '10 minutes',
                LEAST(5,(v_result->>'concurrency')::INTEGER),GREATEST(1000,(v_result->>'interval_ms')::INTEGER))
            ON CONFLICT(scope,quota_key) DO UPDATE SET
                retry_at=GREATEST(campaign_shared_quota_cooldowns.retry_at,EXCLUDED.retry_at),
                growth_after=GREATEST(campaign_shared_quota_cooldowns.growth_after,EXCLUDED.growth_after),
                concurrency=CASE WHEN campaign_shared_quota_cooldowns.growth_after>NOW()
                    THEN LEAST(campaign_shared_quota_cooldowns.concurrency,EXCLUDED.concurrency) ELSE EXCLUDED.concurrency END,
                interval_ms=CASE WHEN campaign_shared_quota_cooldowns.growth_after>NOW()
                    THEN GREATEST(campaign_shared_quota_cooldowns.interval_ms,EXCLUDED.interval_ms) ELSE EXCLUDED.interval_ms END;
            UPDATE public.pages p SET campaign_delivery_cooldown_until=GREATEST(p.campaign_delivery_cooldown_until,v_target_retry),
                campaign_delivery_concurrency=LEAST(p.campaign_delivery_concurrency,(v_result->>'concurrency')::INTEGER,5),
                campaign_delivery_interval_ms=GREATEST(p.campaign_delivery_interval_ms,(v_result->>'interval_ms')::INTEGER,1000)
            WHERE p.id<>p_page_id AND EXISTS(SELECT 1 FROM app_private.campaign_page_quota_keys(p.id) k
                WHERE k.scope=v_scope AND k.quota_key=v_key);
            UPDATE public.campaigns c SET next_attempt_at=GREATEST(c.next_attempt_at,v_target_retry)
            WHERE c.status IN ('sending','scheduled') AND EXISTS(SELECT 1 FROM app_private.campaign_page_quota_keys(c.page_id) k
                WHERE k.scope=v_scope AND k.quota_key=v_key);
        END LOOP;
    END IF;
    SELECT MAX(q.retry_at),MAX(q.growth_after),MIN(q.concurrency),MAX(q.interval_ms)
    INTO v_retry,v_growth,v_concurrency,v_interval
    FROM app_private.campaign_page_quota_keys(p_page_id) k
    JOIN app_private.campaign_shared_quota_cooldowns q ON q.scope=k.scope AND q.quota_key=k.quota_key
    WHERE q.growth_after>NOW();
    IF v_growth IS NOT NULL THEN
        UPDATE public.pages SET campaign_delivery_cooldown_until=GREATEST(campaign_delivery_cooldown_until,v_retry),
            campaign_delivery_concurrency=LEAST(campaign_delivery_concurrency,v_concurrency),
            campaign_delivery_interval_ms=GREATEST(campaign_delivery_interval_ms,v_interval)
        WHERE id=p_page_id;
        SELECT jsonb_build_object('owned',TRUE,'concurrency',campaign_delivery_concurrency,
            'interval_ms',campaign_delivery_interval_ms,'retry_at',campaign_delivery_cooldown_until,
            'growth_after',GREATEST((v_result->>'growth_after')::TIMESTAMPTZ,v_growth)) INTO v_result
        FROM public.pages WHERE id=p_page_id;
    END IF;
    RETURN v_result;
END; $$;

CREATE OR REPLACE FUNCTION public.acquire_page_campaign_delivery(p_page_id UUID,p_owner UUID)
RETURNS TABLE(acquired BOOLEAN,retry_at TIMESTAMPTZ,batch_size INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_retry TIMESTAMPTZ; v_busy TIMESTAMPTZ;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('campaign_meta_shared_quota',0));
    SELECT GREATEST((SELECT p.campaign_delivery_cooldown_until FROM public.pages p WHERE p.id=p_page_id),MAX(q.retry_at))
    INTO v_retry FROM app_private.campaign_page_quota_keys(p_page_id) k
    JOIN app_private.campaign_shared_quota_cooldowns q ON q.scope=k.scope AND q.quota_key=k.quota_key
    WHERE q.retry_at>NOW();
    IF v_retry>NOW() THEN RETURN QUERY SELECT FALSE,v_retry,1; RETURN; END IF;
    -- During a shared recovery hold, one Page probes the quota at a time.
    -- Healthy unrelated Pages retain independent workers and learned speeds.
    SELECT MIN(p.campaign_delivery_lease_until) INTO v_busy FROM public.pages p
    WHERE p.id<>p_page_id AND p.campaign_delivery_lease_until>NOW() AND EXISTS(
        SELECT 1 FROM app_private.campaign_page_quota_keys(p_page_id) mine
        JOIN app_private.campaign_shared_quota_cooldowns q ON q.scope=mine.scope AND q.quota_key=mine.quota_key
        JOIN app_private.campaign_page_quota_keys(p.id) theirs ON theirs.scope=q.scope AND theirs.quota_key=q.quota_key
        WHERE q.growth_after>NOW());
    IF v_busy IS NOT NULL THEN RETURN QUERY SELECT FALSE,LEAST(v_busy,NOW()+INTERVAL '5 seconds'),1; RETURN; END IF;
    RETURN QUERY SELECT * FROM public.acquire_page_campaign_delivery_local(p_page_id,p_owner);
END; $$;
CREATE OR REPLACE FUNCTION public.acquire_page_campaign_delivery_v2(p_page_id UUID,p_owner UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_result RECORD; v_cooling BOOLEAN;
BEGIN
    SELECT * INTO v_result FROM public.acquire_page_campaign_delivery(p_page_id,p_owner);
    IF v_result.acquired THEN RETURN jsonb_build_object('acquired',TRUE,'retry_at',NULL,
        'batch_size',v_result.batch_size,'reason',NULL); END IF;
    SELECT COALESCE(p.campaign_delivery_cooldown_until>NOW(),FALSE) OR EXISTS(
        SELECT 1 FROM app_private.campaign_page_quota_keys(p_page_id) k
        JOIN app_private.campaign_shared_quota_cooldowns q ON q.scope=k.scope AND q.quota_key=k.quota_key
        WHERE q.retry_at>NOW()) INTO v_cooling FROM public.pages p WHERE p.id=p_page_id;
    RETURN jsonb_build_object('acquired',FALSE,'retry_at',CASE WHEN v_cooling THEN v_result.retry_at
        ELSE LEAST(v_result.retry_at,NOW()+INTERVAL '2 seconds') END,'batch_size',v_result.batch_size,
        'reason',CASE WHEN v_cooling THEN 'cooldown' ELSE 'busy' END);
END; $$;
REVOKE ALL ON FUNCTION public.record_page_campaign_quota_identity(UUID,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.acquire_page_campaign_delivery(UUID,UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.acquire_page_campaign_delivery_v2(UUID,UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.report_page_campaign_delivery_feedback(UUID,UUID,INTEGER,INTEGER,BOOLEAN,INTEGER,TEXT)
    FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_page_campaign_quota_identity(UUID,TEXT,TEXT),
    public.acquire_page_campaign_delivery(UUID,UUID),
    public.acquire_page_campaign_delivery_v2(UUID,UUID),
    public.report_page_campaign_delivery_feedback(UUID,UUID,INTEGER,INTEGER,BOOLEAN,INTEGER,TEXT) TO postgres,service_role;
INSERT INTO app_private.schema_migrations(version,description)
VALUES('20261111_002','Coordinate campaign cooldowns by verified token owner and observed business quota')
ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
