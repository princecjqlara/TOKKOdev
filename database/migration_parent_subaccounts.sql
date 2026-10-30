-- Run after the account preparation, expiry, password options and original
-- Facebook access migrations. Existing accounts remain permanent by default.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS delete_after_expiry BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS users_temporary_subaccount_deadline ON public.users(expires_at)
 WHERE delete_after_expiry AND created_by IS NOT NULL;

CREATE OR REPLACE FUNCTION public.tokko_assert_manager(p_actor UUID,p_pages UUID[]) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NOT tokko_accounts_ready() THEN RAISE EXCEPTION 'Account feature not finalized' USING ERRCODE='55000'; END IF;
 IF COALESCE(cardinality(p_pages),0)<1 OR cardinality(p_pages)>50 THEN RAISE EXCEPTION 'Select Pages'; END IF;
 IF NOT EXISTS(SELECT 1 FROM users u WHERE u.id=p_actor AND u.created_by IS NULL
  AND u.account_kind IN ('facebook','legacy') AND u.is_active AND (u.expires_at IS NULL OR u.expires_at>now())) OR EXISTS(
  SELECT 1 FROM unnest(p_pages) AS selected(page_id) WHERE NOT EXISTS(
   SELECT 1 FROM tokko_page_managers m JOIN user_pages up USING(user_id,page_id)
   JOIN tokko_auth_identities i ON i.user_id=m.user_id AND i.provider='facebook' AND i.subject=m.facebook_subject
   WHERE m.user_id=p_actor AND m.page_id=selected.page_id AND m.verified_at>now()-interval '1 minute'))
 THEN RAISE EXCEPTION 'Original Facebook parent account required' USING ERRCODE='42501'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_set_subaccount_lifetime(
 p_actor UUID,p_pages UUID[],p_user UUID,p_expiry_set BOOLEAN,p_expires_at TIMESTAMPTZ,
 p_lifetime_days INTEGER,p_delete_after_expiry BOOLEAN)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user users%ROWTYPE; v_deadline TIMESTAMPTZ;
BEGIN
 PERFORM tokko_assert_manager(p_actor,p_pages);
 IF p_lifetime_days IS NOT NULL AND p_lifetime_days NOT BETWEEN 1 AND 3650 THEN RAISE EXCEPTION 'Choose 1 to 3650 days' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_user FROM users WHERE id=p_user FOR UPDATE;
 IF NOT FOUND OR v_user.created_by IS DISTINCT FROM p_actor OR v_user.account_kind NOT IN ('invited','email')
  OR v_user.facebook_id IS NOT NULL OR EXISTS(SELECT 1 FROM tokko_auth_identities WHERE user_id=p_user)
  OR NOT EXISTS(SELECT 1 FROM user_pages WHERE user_id=p_user AND page_id=ANY(p_pages)) THEN RETURN FALSE; END IF;
 v_deadline:=CASE WHEN p_lifetime_days IS NOT NULL THEN now()+make_interval(days=>p_lifetime_days)
  WHEN p_expiry_set THEN p_expires_at ELSE v_user.expires_at END;
 IF v_deadline IS NOT NULL AND v_deadline<=now() THEN RAISE EXCEPTION 'Choose a future deadline' USING ERRCODE='22023'; END IF;
 IF COALESCE(p_delete_after_expiry,v_user.delete_after_expiry) AND v_deadline IS NULL
  AND p_delete_after_expiry IS TRUE THEN RAISE EXCEPTION 'Temporary subaccounts need a deadline' USING ERRCODE='22023'; END IF;
 UPDATE users SET expires_at=v_deadline,
  delete_after_expiry=CASE WHEN v_deadline IS NULL THEN FALSE ELSE COALESCE(p_delete_after_expiry,delete_after_expiry) END,
  updated_at=now() WHERE id=p_user;
 INSERT INTO tokko_access_audit(actor_id,user_id,action) VALUES(p_actor,p_user,'subaccount_lifetime_updated');
 RETURN TRUE;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_save_subaccount(
 p_actor UUID,p_pages UUID[],p_email TEXT,p_name TEXT,p_request UUID,p_fingerprint TEXT,
 p_setup_method TEXT,p_hash TEXT,p_encrypted TEXT,p_password TEXT,
 p_expiry_set BOOLEAN,p_expires_at TIMESTAMPTZ,p_lifetime_days INTEGER,p_delete_after_expiry BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_prior tokko_account_requests%ROWTYPE; v_result JSONB; v_deadline TIMESTAMPTZ;
BEGIN
 PERFORM tokko_assert_manager(p_actor,p_pages);
 IF p_setup_method NOT IN ('password','email','existing') OR p_setup_method IS NULL THEN RAISE EXCEPTION 'Choose account setup' USING ERRCODE='22023'; END IF;
 IF p_lifetime_days IS NOT NULL AND p_lifetime_days NOT BETWEEN 1 AND 3650 THEN RAISE EXCEPTION 'Choose 1 to 3650 days' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('account-request:'||p_actor||p_request,0));
 SELECT * INTO v_prior FROM tokko_account_requests WHERE actor_id=p_actor AND request_id=p_request;
 IF FOUND THEN
  IF v_prior.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='22023'; END IF;
  RETURN v_prior.result;
 END IF;
 v_deadline:=CASE WHEN p_lifetime_days IS NOT NULL THEN now()+make_interval(days=>p_lifetime_days) ELSE p_expires_at END;
 IF p_setup_method='password' THEN
  v_result:=tokko_provision_member_with_password(p_actor,p_pages,p_email,p_name,p_request,p_fingerprint,p_hash,p_password,p_expiry_set OR p_lifetime_days IS NOT NULL,v_deadline);
 ELSIF p_setup_method='existing' THEN
  v_result:=tokko_assign_existing_member(p_actor,p_pages,p_email,p_name,p_request,p_fingerprint,p_hash,'',p_expiry_set OR p_lifetime_days IS NOT NULL,v_deadline);
 ELSE
  v_result:=tokko_provision_member_with_expiry(p_actor,p_pages,p_email,p_name,p_request,p_fingerprint,p_hash,p_encrypted,p_expiry_set OR p_lifetime_days IS NOT NULL,v_deadline);
 END IF;
 IF p_delete_after_expiry IS NOT NULL THEN
  IF NOT tokko_set_subaccount_lifetime(p_actor,p_pages,(v_result->>'userId')::uuid,FALSE,NULL,NULL,p_delete_after_expiry) THEN
   RAISE EXCEPTION 'Only the parent can schedule subaccount deletion' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_delete_expired_subaccounts(p_limit INTEGER DEFAULT 100) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user users%ROWTYPE; v_deleted INTEGER:=0; v_failed INTEGER:=0;
 v_deleted_actor UUID:='00000000-0000-4000-8000-000000000001';
BEGIN
 FOR v_user IN SELECT u.* FROM users u WHERE u.delete_after_expiry AND u.expires_at<=now()
  AND u.created_by IS NOT NULL AND u.account_kind IN ('invited','email') AND u.facebook_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM tokko_auth_identities i WHERE i.user_id=u.id)
  ORDER BY u.expires_at,u.id FOR UPDATE OF u SKIP LOCKED LIMIT LEAST(GREATEST(COALESCE(p_limit,100),1),500)
 LOOP
  BEGIN
   -- Shared Page data stays intact. Exports remain with the parent, and the
   -- existing non-null chatbot audit actor gets a non-login deleted-user marker.
   IF to_regclass('public.conversation_export_jobs') IS NOT NULL THEN
    EXECUTE 'UPDATE public.conversation_export_jobs SET created_by=$1 WHERE created_by=$2' USING v_user.created_by,v_user.id;
   END IF;
   IF to_regclass('public.contact_bot_permission_events') IS NOT NULL THEN
    INSERT INTO users(id,name,is_active,account_kind) VALUES(v_deleted_actor,'Deleted team member',FALSE,'system') ON CONFLICT(id) DO NOTHING;
    IF NOT EXISTS(SELECT 1 FROM users WHERE id=v_deleted_actor AND account_kind='system' AND NOT is_active AND facebook_id IS NULL AND password_hash IS NULL AND email IS NULL) THEN
     RAISE EXCEPTION 'Deleted-user marker unavailable';
    END IF;
    EXECUTE 'UPDATE public.contact_bot_permission_events SET actor_id=$1 WHERE actor_id=$2' USING v_deleted_actor,v_user.id;
   END IF;
   IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tags' AND column_name='owner_type') THEN
    EXECUTE 'DELETE FROM public.tags WHERE owner_type=''user'' AND owner_id=$1' USING v_user.id;
   END IF;
   -- Account-owned access, credentials, reset links, and pending mail cascade.
   -- History rows with SET NULL references remain available to the Page team.
   INSERT INTO tokko_access_audit(actor_id,user_id,action) VALUES(v_user.created_by,v_user.id,'temporary_subaccount_deleted:'||v_user.id);
   DELETE FROM users WHERE id=v_user.id;
   v_deleted:=v_deleted+1;
  EXCEPTION WHEN OTHERS THEN
   v_failed:=v_failed+1;
   INSERT INTO tokko_access_audit(actor_id,user_id,action) VALUES(v_user.created_by,v_user.id,'temporary_subaccount_deletion_failed:'||SQLSTATE);
  END;
 END LOOP;
 RETURN jsonb_build_object('deleted',v_deleted,'failed',v_failed);
END $$;

REVOKE ALL ON FUNCTION public.tokko_assert_manager(UUID,UUID[]),
 public.tokko_set_subaccount_lifetime(UUID,UUID[],UUID,BOOLEAN,TIMESTAMPTZ,INTEGER,BOOLEAN),
 public.tokko_save_subaccount(UUID,UUID[],TEXT,TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN,TIMESTAMPTZ,INTEGER,BOOLEAN),
 public.tokko_delete_expired_subaccounts(INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tokko_assert_manager(UUID,UUID[]),
 public.tokko_set_subaccount_lifetime(UUID,UUID[],UUID,BOOLEAN,TIMESTAMPTZ,INTEGER,BOOLEAN),
 public.tokko_save_subaccount(UUID,UUID[],TEXT,TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN,TIMESTAMPTZ,INTEGER,BOOLEAN),
 public.tokko_delete_expired_subaccounts(INTEGER) TO service_role;
INSERT INTO app_private.schema_migrations(version,description)
 VALUES('20261030_005','Parent-owned multi-Page subaccounts and scheduled account deletion') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
