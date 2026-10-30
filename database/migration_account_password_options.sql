-- Run in a transaction after the account, expiry, and Facebook recovery migrations.
-- Does not enable account readiness or change any existing password.
CREATE OR REPLACE FUNCTION public.tokko_provision_member_with_password(
 p_actor UUID,p_pages UUID[],p_email TEXT,p_name TEXT,p_request UUID,p_fingerprint TEXT,p_hash TEXT,
 p_password TEXT,p_expiry_set BOOLEAN,p_expires_at TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_result JSONB; v_prior tokko_account_requests%ROWTYPE; v_user users%ROWTYPE;
BEGIN
 PERFORM tokko_assert_manager(p_actor,p_pages);
 IF p_password IS NULL OR p_password NOT LIKE 'scrypt-v1$%' THEN RAISE EXCEPTION 'Invalid password' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('account-request:'||p_actor||p_request,0));
 SELECT * INTO v_prior FROM tokko_account_requests WHERE actor_id=p_actor AND request_id=p_request;
 IF FOUND THEN
  IF v_prior.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='22023'; END IF;
  RETURN v_prior.result;
 END IF;
 -- Reuse atomic account/grant/expiry handling. Its setup token is consumed and
 -- its empty outbox payload cancelled before this transaction becomes visible.
 v_result:=tokko_provision_member_with_expiry(p_actor,p_pages,p_email,p_name,p_request,p_fingerprint,p_hash,'',p_expiry_set,p_expires_at);
 SELECT * INTO v_user FROM users WHERE id=(v_result->>'userId')::uuid FOR UPDATE;
 IF v_user.is_active OR v_user.account_kind<>'invited' OR v_user.created_by IS DISTINCT FROM p_actor
  OR v_user.password_hash IS NOT NULL OR v_user.email_login_enabled OR v_user.facebook_id IS NOT NULL
  OR EXISTS(SELECT 1 FROM tokko_auth_identities WHERE user_id=v_user.id) THEN
  RAISE EXCEPTION 'Existing credentials cannot be replaced' USING ERRCODE='42501';
 END IF;
 IF v_user.expires_at IS NOT NULL AND v_user.expires_at<=now() THEN RAISE EXCEPTION 'Renew account expiry first' USING ERRCODE='22023'; END IF;
 IF NOT tokko_set_account_password(p_hash,p_password) THEN RAISE EXCEPTION 'Password setup failed' USING ERRCODE='22023'; END IF;
 v_result:=jsonb_build_object('userId',v_user.id,'pending',FALSE,'deliveryId',NULL,'passwordCreated',TRUE);
 UPDATE tokko_account_requests SET result=v_result WHERE actor_id=p_actor AND request_id=p_request;
 INSERT INTO tokko_access_audit(actor_id,user_id,action) VALUES(p_actor,v_user.id,'initial_password_set_by_creator');
 RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_assign_existing_member(
 p_actor UUID,p_pages UUID[],p_email TEXT,p_name TEXT,p_request UUID,p_fingerprint TEXT,p_hash TEXT,p_encrypted TEXT,
 p_expiry_set BOOLEAN,p_expires_at TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user users%ROWTYPE; v_prior tokko_account_requests%ROWTYPE;
BEGIN
 PERFORM tokko_assert_manager(p_actor,p_pages);
 PERFORM pg_advisory_xact_lock(hashtextextended('account-request:'||p_actor||p_request,0));
 SELECT * INTO v_prior FROM tokko_account_requests WHERE actor_id=p_actor AND request_id=p_request;
 IF FOUND THEN
  IF v_prior.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='22023'; END IF;
  RETURN v_prior.result;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('account-email:'||p_email,0));
 SELECT * INTO v_user FROM users WHERE lower(btrim(email))=p_email FOR UPDATE;
 IF NOT FOUND OR NOT v_user.is_active THEN RAISE EXCEPTION 'Existing active account required' USING ERRCODE='22023'; END IF;
 RETURN tokko_provision_member_with_expiry(p_actor,p_pages,p_email,p_name,p_request,p_fingerprint,p_hash,'',p_expiry_set,p_expires_at);
END $$;

CREATE OR REPLACE FUNCTION public.tokko_set_own_password(
 p_user UUID,p_subject TEXT,p_version INTEGER,p_expected_password TEXT,p_password TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user users%ROWTYPE;
BEGIN
 IF NOT tokko_accounts_ready() THEN RAISE EXCEPTION 'Account feature not finalized' USING ERRCODE='55000'; END IF;
 IF p_password IS NULL OR p_password NOT LIKE 'scrypt-v1$%' THEN RETURN FALSE; END IF;
 SELECT * INTO v_user FROM users WHERE id=p_user FOR UPDATE;
 IF NOT FOUND OR NOT v_user.is_active OR v_user.session_version IS DISTINCT FROM p_version
  OR (v_user.expires_at IS NOT NULL AND v_user.expires_at<=now())
  OR v_user.email IS NULL OR btrim(v_user.email) NOT LIKE '%@%.%' OR lower(btrim(v_user.email)) LIKE '%@facebook.local' THEN RETURN FALSE; END IF;
 IF v_user.password_hash IS NULL AND NOT v_user.email_login_enabled THEN
  IF p_expected_password IS NOT NULL OR p_subject IS NULL OR v_user.facebook_id IS DISTINCT FROM p_subject
   OR NOT EXISTS(SELECT 1 FROM tokko_auth_identities WHERE user_id=p_user AND provider='facebook' AND subject=p_subject) THEN RETURN FALSE; END IF;
 ELSE
  -- The server verifies the current password before passing its hash. Compare
  -- again under the account lock so concurrent resets cannot overwrite each other.
  IF NOT v_user.email_login_enabled OR v_user.email_verified_at IS NULL OR p_expected_password IS NULL
   OR v_user.password_hash IS DISTINCT FROM p_expected_password THEN RETURN FALSE; END IF;
 END IF;
 UPDATE users SET password_hash=p_password,email_login_enabled=TRUE,email_verified_at=COALESCE(email_verified_at,now()),
  password_changed_at=now(),session_version=session_version+1,updated_at=now() WHERE id=p_user;
 UPDATE tokko_account_tokens SET consumed_at=now() WHERE user_id=p_user AND consumed_at IS NULL;
 UPDATE tokko_account_mail m SET status='cancelled',encrypted_token='' FROM tokko_account_tokens t
  WHERE m.token_id=t.id AND t.user_id=p_user AND m.status IN ('pending','sending','failed');
 INSERT INTO tokko_access_audit(actor_id,user_id,action) VALUES(p_user,p_user,'own_password_saved');
 RETURN TRUE;
END $$;
REVOKE ALL ON FUNCTION public.tokko_provision_member_with_password(UUID,UUID[],TEXT,TEXT,UUID,TEXT,TEXT,TEXT,BOOLEAN,TIMESTAMPTZ),
 public.tokko_assign_existing_member(UUID,UUID[],TEXT,TEXT,UUID,TEXT,TEXT,TEXT,BOOLEAN,TIMESTAMPTZ),
 public.tokko_set_own_password(UUID,TEXT,INTEGER,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tokko_provision_member_with_password(UUID,UUID[],TEXT,TEXT,UUID,TEXT,TEXT,TEXT,BOOLEAN,TIMESTAMPTZ),
 public.tokko_assign_existing_member(UUID,UUID[],TEXT,TEXT,UUID,TEXT,TEXT,TEXT,BOOLEAN,TIMESTAMPTZ),
 public.tokko_set_own_password(UUID,TEXT,INTEGER,TEXT,TEXT) TO service_role;
INSERT INTO app_private.schema_migrations(version,description)
 VALUES('20261030_003','Initial member passwords and password setup for Facebook accounts') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
