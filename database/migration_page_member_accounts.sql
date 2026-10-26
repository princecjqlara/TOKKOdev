-- Additive preparation. Deploy compatible code, then run the isolation finalizer.
-- Email sign-in and provisioning remain disabled until finalization succeeds.
ALTER TABLE public.users
 ADD COLUMN IF NOT EXISTS password_hash TEXT,
 ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
 ADD COLUMN IF NOT EXISTS email_login_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS account_kind TEXT NOT NULL DEFAULT 'legacy',
 ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.users(id) ON DELETE SET NULL;

-- Resolve collisions deliberately; do not merge identities or rewrite passwords.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.users WHERE email IS NOT NULL GROUP BY lower(btrim(email)) HAVING count(*) > 1)
 THEN RAISE EXCEPTION 'Resolve case-insensitive email collisions before migrating'; END IF;
 IF EXISTS (SELECT 1 FROM public.users WHERE facebook_id IS NOT NULL GROUP BY facebook_id HAVING count(*) > 1)
 THEN RAISE EXCEPTION 'Resolve duplicate Facebook identities before migrating'; END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalized_unique ON public.users(lower(btrim(email))) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_facebook_identity_unique ON public.users(facebook_id) WHERE facebook_id IS NOT NULL;
ALTER TABLE public.user_pages
 ADD COLUMN IF NOT EXISTS grant_source TEXT NOT NULL DEFAULT 'legacy',
 ADD COLUMN IF NOT EXISTS granted_by UUID REFERENCES public.users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.tokko_auth_identities (
 provider TEXT NOT NULL CHECK(provider='facebook'), subject TEXT NOT NULL,
 user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(provider,subject), UNIQUE(user_id,provider)
);
INSERT INTO public.tokko_auth_identities(provider,subject,user_id)
 SELECT 'facebook',facebook_id,id FROM public.users WHERE facebook_id IS NOT NULL ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.tokko_page_managers (
 user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
 page_id UUID REFERENCES public.pages(id) ON DELETE CASCADE,
 facebook_subject TEXT NOT NULL, verified_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(user_id,page_id)
);
CREATE TABLE IF NOT EXISTS public.tokko_account_config (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(id), enabled BOOLEAN NOT NULL DEFAULT FALSE);
INSERT INTO public.tokko_account_config(id) VALUES(TRUE) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.tokko_account_tokens (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 page_id UUID REFERENCES public.pages(id) ON DELETE SET NULL, page_ids UUID[] NOT NULL DEFAULT '{}',
 purpose TEXT NOT NULL CHECK(purpose IN ('setup','reset','link_facebook')), facebook_subject TEXT, token_hash TEXT NOT NULL UNIQUE,
 expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.tokko_account_mail (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), token_id UUID NOT NULL REFERENCES public.tokko_account_tokens(id) ON DELETE CASCADE,
 encrypted_token TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','cancelled','failed')),
 attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 lease_until TIMESTAMPTZ, claim_token UUID, sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tokko_account_mail_due ON public.tokko_account_mail(next_attempt_at) WHERE status IN ('pending','sending');
CREATE TABLE IF NOT EXISTS public.tokko_account_requests (
 actor_id UUID REFERENCES public.users(id) ON DELETE CASCADE, request_id UUID NOT NULL,
 fingerprint TEXT NOT NULL, result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(actor_id,request_id)
);
CREATE TABLE IF NOT EXISTS public.tokko_access_audit (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
 user_id UUID REFERENCES public.users(id) ON DELETE SET NULL, page_id UUID REFERENCES public.pages(id) ON DELETE CASCADE,
 action TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.tokko_auth_limits (
 bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION public.tokko_accounts_ready() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT COALESCE((SELECT enabled FROM tokko_account_config WHERE id),FALSE)
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')
  AND ((c.relkind IN ('r','p') AND NOT c.relrowsecurity)
   OR has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
   OR has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef AND
   (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE')))
 AND NOT EXISTS(SELECT 1 FROM storage.buckets WHERE id IN ('photo-headers','conversation-exports','messenger-agent-media','chatbot-media') AND public)
 AND NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects'
  AND (roles && ARRAY['public','anon','authenticated']::name[]))
$$;

CREATE OR REPLACE FUNCTION public.tokko_take_auth_limit(p_bucket TEXT,p_limit INTEGER,p_seconds INTEGER) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_attempts INTEGER;
BEGIN
 IF length(p_bucket)>200 OR p_limit<1 OR p_seconds<1 THEN RAISE EXCEPTION 'Invalid rate limit'; END IF;
 INSERT INTO tokko_auth_limits(bucket,attempts,expires_at) VALUES(p_bucket,1,now()+make_interval(secs=>p_seconds))
 ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN tokko_auth_limits.expires_at<=now() THEN 1 ELSE tokko_auth_limits.attempts+1 END,
 expires_at=CASE WHEN tokko_auth_limits.expires_at<=now() THEN EXCLUDED.expires_at ELSE tokko_auth_limits.expires_at END
 RETURNING attempts INTO v_attempts;
 DELETE FROM tokko_auth_limits WHERE bucket IN(SELECT bucket FROM tokko_auth_limits WHERE expires_at<now()-interval '1 day' LIMIT 100);
 RETURN v_attempts<=p_limit;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_email_login_record(p_email TEXT)
RETURNS TABLE(id UUID,name TEXT,email TEXT,image TEXT,password_hash TEXT,is_active BOOLEAN,email_login_enabled BOOLEAN,email_verified_at TIMESTAMPTZ,session_version INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT u.id,u.name,u.email,u.image,u.password_hash,u.is_active,u.email_login_enabled,u.email_verified_at,u.session_version
 FROM users u WHERE lower(btrim(u.email))=p_email AND tokko_accounts_ready()
$$;

CREATE OR REPLACE FUNCTION public.tokko_resolve_facebook_user(p_subject TEXT,p_email TEXT,p_name TEXT,p_image TEXT,p_legacy_id UUID DEFAULT NULL)
RETURNS TABLE(user_id UUID,version INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user public.users%ROWTYPE;
BEGIN
 IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid Facebook identity'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('facebook:'||p_subject,0));
 SELECT u.* INTO v_user FROM users u JOIN tokko_auth_identities i ON i.user_id=u.id WHERE i.provider='facebook' AND i.subject=p_subject FOR UPDATE OF u;
 IF v_user.id IS NULL THEN
  SELECT * INTO v_user FROM users WHERE facebook_id=p_subject FOR UPDATE;
 END IF;
 IF v_user.id IS NULL AND p_legacy_id IS NOT NULL THEN
  -- p_legacy_id is accepted only from a previously signed JWT for this same FB subject.
  SELECT * INTO v_user FROM users WHERE id=p_legacy_id AND account_kind='legacy' AND NOT email_login_enabled AND password_hash IS NULL AND facebook_id IS NULL FOR UPDATE;
 END IF;
 IF v_user.id IS NULL THEN
  IF EXISTS(SELECT 1 FROM users WHERE lower(btrim(email))=lower(btrim(p_email))) THEN
   RAISE EXCEPTION 'Identity requires explicit reconciliation' USING ERRCODE='28000';
  END IF;
  INSERT INTO users(email,name,image,facebook_id,is_active,account_kind)
  VALUES(COALESCE(NULLIF(lower(btrim(p_email)),''),'fb_'||p_subject||'@facebook.local'),p_name,p_image,p_subject,TRUE,'facebook') RETURNING * INTO v_user;
 END IF;
 IF NOT v_user.is_active THEN RAISE EXCEPTION 'Account inactive' USING ERRCODE='28000'; END IF;
 INSERT INTO tokko_auth_identities(provider,subject,user_id) VALUES('facebook',p_subject,v_user.id) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM tokko_auth_identities i WHERE i.provider='facebook' AND i.subject=p_subject AND i.user_id=v_user.id) THEN RAISE EXCEPTION 'Identity mismatch'; END IF;
 UPDATE users SET facebook_id=p_subject,account_kind='facebook',name=COALESCE(p_name,name),image=p_image,updated_at=now() WHERE id=v_user.id;
 RETURN QUERY SELECT v_user.id,v_user.session_version;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_assert_manager(p_actor UUID,p_pages UUID[]) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NOT tokko_accounts_ready() THEN RAISE EXCEPTION 'Account feature not finalized' USING ERRCODE='55000'; END IF;
 IF COALESCE(cardinality(p_pages),0)<1 OR cardinality(p_pages)>50 THEN RAISE EXCEPTION 'Select Pages'; END IF;
 IF NOT EXISTS(SELECT 1 FROM users WHERE id=p_actor AND is_active) OR EXISTS(
  SELECT 1 FROM unnest(p_pages) AS selected(page_id) WHERE NOT EXISTS(
   SELECT 1 FROM tokko_page_managers m JOIN user_pages up USING(user_id,page_id)
   JOIN tokko_auth_identities i ON i.user_id=m.user_id AND i.provider='facebook' AND i.subject=m.facebook_subject
   WHERE m.user_id=p_actor AND m.page_id=selected.page_id AND m.verified_at>now()-interval '1 minute'))
 THEN RAISE EXCEPTION 'Verified Facebook Page manager required' USING ERRCODE='42501'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_provision_member(p_actor UUID,p_pages UUID[],p_email TEXT,p_name TEXT,p_request UUID,p_fingerprint TEXT,p_hash TEXT,p_encrypted TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user users%ROWTYPE; v_request tokko_account_requests%ROWTYPE; v_token UUID; v_mail UUID; v_result JSONB; v_page UUID;
BEGIN
 PERFORM tokko_assert_manager(p_actor,p_pages);
 PERFORM pg_advisory_xact_lock(hashtextextended('account-request:'||p_actor||p_request,0));
 SELECT * INTO v_request FROM tokko_account_requests WHERE actor_id=p_actor AND request_id=p_request;
 IF FOUND THEN
  IF v_request.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='22023'; END IF;
  RETURN v_request.result;
 END IF;
 IF p_email<>lower(btrim(p_email)) OR length(p_email)>254 OR p_email NOT LIKE '%@%.%' OR p_email LIKE '%@facebook.local' OR length(btrim(p_name)) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid account details' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('account-email:'||p_email,0));
 SELECT * INTO v_user FROM users WHERE lower(btrim(email))=p_email FOR UPDATE;
 IF v_user.id IS NULL THEN
  INSERT INTO users(email,name,is_active,account_kind,created_by) VALUES(p_email,btrim(p_name),FALSE,'invited',p_actor) RETURNING * INTO v_user;
 ELSIF NOT v_user.is_active AND (v_user.account_kind<>'invited' OR v_user.password_hash IS NOT NULL OR v_user.email_login_enabled) THEN
  RAISE EXCEPTION 'Account unavailable' USING ERRCODE='22023';
 END IF;
 FOREACH v_page IN ARRAY p_pages LOOP
  INSERT INTO user_pages(user_id,page_id,grant_source,granted_by) VALUES(v_user.id,v_page,'delegated',p_actor) ON CONFLICT(user_id,page_id) DO NOTHING;
  INSERT INTO tokko_access_audit(actor_id,user_id,page_id,action) VALUES(p_actor,v_user.id,v_page,'page_access_granted');
 END LOOP;
 IF NOT v_user.is_active THEN
  -- A setup link is scoped to a Page context. Other contexts remain independent.
  UPDATE tokko_account_tokens SET consumed_at=now() WHERE user_id=v_user.id AND purpose='setup' AND page_ids=p_pages AND consumed_at IS NULL;
  INSERT INTO tokko_account_tokens(user_id,page_id,page_ids,purpose,token_hash,expires_at) VALUES(v_user.id,p_pages[1],p_pages,'setup',p_hash,now()+interval '24 hours') RETURNING id INTO v_token;
  INSERT INTO tokko_account_mail(token_id,encrypted_token) VALUES(v_token,p_encrypted) RETURNING id INTO v_mail;
 END IF;
 v_result:=jsonb_build_object('userId',v_user.id,'pending',NOT v_user.is_active,'deliveryId',v_mail);
 INSERT INTO tokko_account_requests(actor_id,request_id,fingerprint,result) VALUES(p_actor,p_request,p_fingerprint,v_result);
 RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_revoke_member(p_actor UUID,p_page UUID,p_user UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_count INTEGER;
BEGIN
 PERFORM tokko_assert_manager(p_actor,ARRAY[p_page]);
 PERFORM 1 FROM users WHERE id=p_user FOR UPDATE;
 DELETE FROM user_pages WHERE user_id=p_user AND page_id=p_page AND grant_source='delegated'
 AND NOT EXISTS(SELECT 1 FROM tokko_page_managers WHERE user_id=p_user AND page_id=p_page);
 GET DIAGNOSTICS v_count=ROW_COUNT;
 IF v_count>0 THEN
  UPDATE tokko_account_tokens SET page_ids=array_remove(page_ids,p_page),
   consumed_at=CASE WHEN cardinality(array_remove(page_ids,p_page))=0 THEN now() ELSE NULL END
  WHERE user_id=p_user AND p_page=ANY(page_ids) AND purpose='setup' AND consumed_at IS NULL;
  UPDATE tokko_account_mail m SET status='cancelled',encrypted_token='' FROM tokko_account_tokens t
  WHERE m.token_id=t.id AND t.user_id=p_user AND t.purpose='setup' AND t.consumed_at IS NOT NULL AND m.status IN ('pending','sending','failed');
  INSERT INTO tokko_access_audit(actor_id,user_id,page_id,action) VALUES(p_actor,p_user,p_page,'page_access_revoked');
 END IF;
 RETURN v_count>0;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_queue_password_reset(p_email TEXT,p_hash TEXT,p_encrypted TEXT) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user users%ROWTYPE; v_token UUID; v_mail UUID;
BEGIN
 IF NOT tokko_accounts_ready() THEN RETURN NULL; END IF;
 SELECT * INTO v_user FROM users WHERE lower(btrim(email))=p_email AND is_active AND email_login_enabled AND email_verified_at IS NOT NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE tokko_account_tokens SET consumed_at=now() WHERE user_id=v_user.id AND purpose='reset' AND consumed_at IS NULL;
 INSERT INTO tokko_account_tokens(user_id,purpose,token_hash,expires_at) VALUES(v_user.id,'reset',p_hash,now()+interval '30 minutes') RETURNING id INTO v_token;
 INSERT INTO tokko_account_mail(token_id,encrypted_token) VALUES(v_token,p_encrypted) RETURNING id INTO v_mail;
 RETURN v_mail;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_queue_facebook_link(p_email TEXT,p_subject TEXT,p_hash TEXT,p_encrypted TEXT) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user users%ROWTYPE; v_token UUID; v_mail UUID;
BEGIN
 IF NOT tokko_accounts_ready() OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 100 THEN RETURN NULL; END IF;
 SELECT * INTO v_user FROM users WHERE lower(btrim(email))=p_email AND is_active AND facebook_id IS NULL FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM tokko_auth_identities WHERE user_id=v_user.id OR (provider='facebook' AND subject=p_subject)) THEN RETURN NULL; END IF;
 UPDATE tokko_account_tokens SET consumed_at=now() WHERE user_id=v_user.id AND purpose='link_facebook' AND facebook_subject=p_subject AND consumed_at IS NULL;
 INSERT INTO tokko_account_tokens(user_id,purpose,facebook_subject,token_hash,expires_at) VALUES(v_user.id,'link_facebook',p_subject,p_hash,now()+interval '15 minutes') RETURNING id INTO v_token;
 INSERT INTO tokko_account_mail(token_id,encrypted_token) VALUES(v_token,p_encrypted) RETURNING id INTO v_mail;
 RETURN v_mail;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_confirm_facebook_link(p_hash TEXT,p_subject TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_token tokko_account_tokens%ROWTYPE; v_user users%ROWTYPE;
BEGIN
 IF NOT tokko_accounts_ready() THEN RETURN FALSE; END IF;
 SELECT * INTO v_token FROM tokko_account_tokens WHERE token_hash=p_hash;
 IF NOT FOUND THEN RETURN FALSE; END IF;
 SELECT * INTO v_user FROM users WHERE id=v_token.user_id FOR UPDATE;
 SELECT * INTO v_token FROM tokko_account_tokens WHERE token_hash=p_hash FOR UPDATE;
 IF v_token.purpose<>'link_facebook' OR v_token.facebook_subject IS DISTINCT FROM p_subject OR v_token.consumed_at IS NOT NULL OR v_token.expires_at<=now()
  OR NOT v_user.is_active OR v_user.facebook_id IS NOT NULL THEN RETURN FALSE; END IF;
 IF EXISTS(SELECT 1 FROM tokko_auth_identities WHERE user_id=v_user.id OR (provider='facebook' AND subject=p_subject)) THEN RETURN FALSE; END IF;
 INSERT INTO tokko_auth_identities(provider,subject,user_id) VALUES('facebook',p_subject,v_user.id);
 UPDATE users SET facebook_id=p_subject,account_kind=CASE WHEN account_kind='legacy' THEN 'facebook' ELSE account_kind END,
  session_version=session_version+1,updated_at=now() WHERE id=v_user.id;
 UPDATE tokko_account_tokens SET consumed_at=now() WHERE user_id=v_user.id AND purpose='link_facebook' AND consumed_at IS NULL;
 UPDATE tokko_account_mail m SET status='cancelled',encrypted_token='' FROM tokko_account_tokens t WHERE m.token_id=t.id AND t.user_id=v_user.id AND t.purpose='link_facebook' AND m.status IN ('pending','sending','failed');
 INSERT INTO tokko_access_audit(user_id,action) VALUES(v_user.id,'facebook_identity_verified');
 RETURN TRUE;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_set_account_password(p_hash TEXT,p_password TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_token tokko_account_tokens%ROWTYPE; v_user users%ROWTYPE;
BEGIN
 IF NOT tokko_accounts_ready() OR p_password NOT LIKE 'scrypt-v1$%' THEN RETURN FALSE; END IF;
 SELECT * INTO v_token FROM tokko_account_tokens WHERE token_hash=p_hash;
 IF NOT FOUND OR v_token.consumed_at IS NOT NULL OR v_token.expires_at<=now() THEN RETURN FALSE; END IF;
 SELECT * INTO v_user FROM users WHERE id=v_token.user_id FOR UPDATE;
 -- All account-token mutations lock the account before token rows. This
 -- avoids deadlocks when setup links for two different Pages race.
 SELECT * INTO v_token FROM tokko_account_tokens WHERE token_hash=p_hash FOR UPDATE;
 IF NOT FOUND OR v_token.consumed_at IS NOT NULL OR v_token.expires_at<=now() THEN RETURN FALSE; END IF;
 IF v_token.purpose='setup' THEN
  IF v_user.is_active OR v_user.account_kind<>'invited' OR v_user.password_hash IS NOT NULL OR v_user.email_login_enabled OR NOT EXISTS(SELECT 1 FROM user_pages WHERE user_id=v_user.id AND page_id=ANY(v_token.page_ids)) THEN RETURN FALSE; END IF;
 ELSIF v_token.purpose='reset' THEN
  IF NOT v_user.is_active OR NOT v_user.email_login_enabled OR v_user.email_verified_at IS NULL THEN RETURN FALSE; END IF;
 ELSE
  RETURN FALSE;
 END IF;
 UPDATE users SET password_hash=p_password,account_kind=CASE WHEN account_kind='invited' THEN 'email' ELSE account_kind END,email_login_enabled=TRUE,is_active=TRUE,email_verified_at=COALESCE(email_verified_at,now()),password_changed_at=now(),session_version=session_version+1,updated_at=now() WHERE id=v_user.id;
 UPDATE tokko_account_tokens SET consumed_at=now() WHERE user_id=v_user.id AND consumed_at IS NULL;
 UPDATE tokko_account_mail m SET status='cancelled',encrypted_token='' FROM tokko_account_tokens t WHERE m.token_id=t.id AND t.user_id=v_user.id AND m.status IN ('pending','sending','failed');
 INSERT INTO tokko_access_audit(user_id,action) VALUES(v_user.id,'password_set');
 RETURN TRUE;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_claim_account_mail(p_id UUID DEFAULT NULL)
RETURNS TABLE(id UUID,claim_token UUID,email TEXT,encrypted_token TEXT,purpose TEXT,expires_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id UUID; v_claim UUID:=gen_random_uuid();
BEGIN
 IF NOT tokko_accounts_ready() THEN RETURN; END IF;
 UPDATE tokko_account_mail m SET status=CASE WHEN m.attempt_count>=5 THEN 'failed' ELSE 'cancelled' END,encrypted_token='',lease_until=NULL
 FROM tokko_account_tokens t WHERE t.id=m.token_id AND m.status IN ('pending','sending')
 AND (t.consumed_at IS NOT NULL OR t.expires_at<=now() OR (m.attempt_count>=5 AND (m.lease_until IS NULL OR m.lease_until<=now())));
 SELECT m.id INTO v_id FROM tokko_account_mail m JOIN tokko_account_tokens t ON t.id=m.token_id JOIN users u ON u.id=t.user_id
 WHERE (p_id IS NULL OR m.id=p_id) AND m.status IN ('pending','sending') AND m.next_attempt_at<=now()
 AND (m.lease_until IS NULL OR m.lease_until<=now()) AND m.attempt_count<5
 AND t.consumed_at IS NULL AND t.expires_at>now() AND (t.purpose<>'setup' OR EXISTS(SELECT 1 FROM user_pages up WHERE up.user_id=t.user_id AND up.page_id=ANY(t.page_ids)))
 ORDER BY m.created_at FOR UPDATE OF m SKIP LOCKED LIMIT 1;
 IF v_id IS NULL THEN RETURN; END IF;
 UPDATE tokko_account_mail m SET status='sending',claim_token=v_claim,lease_until=now()+interval '2 minutes',attempt_count=attempt_count+1 WHERE m.id=v_id;
 RETURN QUERY SELECT m.id,v_claim,u.email,m.encrypted_token,t.purpose,t.expires_at FROM tokko_account_mail m JOIN tokko_account_tokens t ON t.id=m.token_id JOIN users u ON u.id=t.user_id WHERE m.id=v_id;
END $$;

-- Secure new objects immediately, even before the broader isolation finalizer.
DO $$ DECLARE r RECORD; BEGIN
 FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'tokko\_%' ESCAPE '\' LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',r.tablename);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',r.tablename);
  EXECUTE format('GRANT ALL ON public.%I TO service_role',r.tablename);
 END LOOP;
 FOR r IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'tokko\_%' ESCAPE '\' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',r.signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.signature);
 END LOOP;
END $$;
INSERT INTO app_private.schema_migrations(version,description) VALUES('20261026_002','Prepare verified Page-manager provisioning and email member accounts') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
