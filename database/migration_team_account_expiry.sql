-- Run after migration_page_member_accounts.sql and before deploying expiry code.
-- NULL preserves unlimited account lifetime. Existing users are unchanged.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE public.tokko_page_managers ADD COLUMN IF NOT EXISTS authority_source TEXT NOT NULL DEFAULT 'facebook'
 CHECK(authority_source IN ('facebook','original'));

-- Original Facebook connections and legacy Page assignments may administer
-- their own Pages. Delegated memberships never acquire this authority.
CREATE OR REPLACE FUNCTION public.tokko_assert_manager(p_actor UUID,p_pages UUID[]) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NOT tokko_accounts_ready() THEN RAISE EXCEPTION 'Account feature not finalized' USING ERRCODE='55000'; END IF;
 IF COALESCE(cardinality(p_pages),0)<1 OR cardinality(p_pages)>50 THEN RAISE EXCEPTION 'Select Pages'; END IF;
 IF NOT EXISTS(SELECT 1 FROM users WHERE id=p_actor AND is_active AND (expires_at IS NULL OR expires_at>now())) OR EXISTS(
  SELECT 1 FROM unnest(p_pages) AS selected(page_id) WHERE NOT EXISTS(
   SELECT 1 FROM tokko_page_managers m JOIN user_pages up USING(user_id,page_id)
   JOIN tokko_auth_identities i ON i.user_id=m.user_id AND i.provider='facebook' AND i.subject=m.facebook_subject
   WHERE m.user_id=p_actor AND m.page_id=selected.page_id AND m.verified_at>now()-interval '1 minute'
   AND (m.authority_source='facebook' OR (m.authority_source='original' AND up.grant_source IN ('legacy','facebook')))))
 THEN RAISE EXCEPTION 'Facebook Page administrator required' USING ERRCODE='42501'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_email_login_record(p_email TEXT)
RETURNS TABLE(id UUID,name TEXT,email TEXT,image TEXT,password_hash TEXT,is_active BOOLEAN,email_login_enabled BOOLEAN,email_verified_at TIMESTAMPTZ,session_version INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT u.id,u.name,u.email,u.image,u.password_hash,u.is_active,u.email_login_enabled,u.email_verified_at,u.session_version
 FROM users u WHERE lower(btrim(u.email))=p_email AND tokko_accounts_ready()
 AND (u.expires_at IS NULL OR u.expires_at>now())
$$;

CREATE OR REPLACE FUNCTION public.tokko_set_member_expiry(p_actor UUID,p_pages UUID[],p_user UUID,p_expires_at TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user users%ROWTYPE;
BEGIN
 PERFORM tokko_assert_manager(p_actor,p_pages);
 IF p_expires_at IS NOT NULL AND p_expires_at<=now() THEN
  RAISE EXCEPTION 'Choose a future expiry' USING ERRCODE='22023';
 END IF;
 SELECT * INTO v_user FROM users WHERE id=p_user FOR UPDATE;
 -- A Page assignment must never give its grantor control of someone else's
 -- entire account, or of an independently connected Facebook identity.
 IF NOT FOUND OR v_user.created_by IS DISTINCT FROM p_actor
  OR v_user.account_kind NOT IN ('invited','email') OR v_user.facebook_id IS NOT NULL
  OR EXISTS(SELECT 1 FROM tokko_auth_identities WHERE user_id=p_user)
  OR NOT EXISTS(SELECT 1 FROM user_pages WHERE user_id=p_user AND page_id=ANY(p_pages)) THEN
  RETURN FALSE;
 END IF;
 IF v_user.expires_at IS DISTINCT FROM p_expires_at THEN
  UPDATE users SET expires_at=p_expires_at,updated_at=now() WHERE id=p_user;
  INSERT INTO tokko_access_audit(actor_id,user_id,action) VALUES(p_actor,p_user,
   CASE WHEN p_expires_at IS NULL THEN 'account_expiry_removed' ELSE 'account_expiry_updated' END);
 END IF;
 RETURN TRUE;
END $$;

-- Keep the original RPC signature available during rollout. The wrapper makes
-- account provisioning and optional expiry one transaction, including retries.
CREATE OR REPLACE FUNCTION public.tokko_provision_member_with_expiry(
 p_actor UUID,p_pages UUID[],p_email TEXT,p_name TEXT,p_request UUID,p_fingerprint TEXT,p_hash TEXT,p_encrypted TEXT,
 p_expiry_set BOOLEAN,p_expires_at TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_result JSONB;
BEGIN
 -- The original function serializes this request and validates its fingerprint.
 -- An already completed retry must not reapply an old expiry over a later edit.
 PERFORM tokko_assert_manager(p_actor,p_pages);
 PERFORM pg_advisory_xact_lock(hashtextextended('account-request:'||p_actor||p_request,0));
 SELECT result INTO v_result FROM tokko_account_requests WHERE actor_id=p_actor AND request_id=p_request;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM tokko_account_requests WHERE actor_id=p_actor AND request_id=p_request AND fingerprint=p_fingerprint) THEN
   RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='22023';
  END IF;
  RETURN v_result;
 END IF;
 v_result:=tokko_provision_member(p_actor,p_pages,p_email,p_name,p_request,p_fingerprint,p_hash,p_encrypted);
 IF p_expiry_set AND NOT tokko_set_member_expiry(p_actor,p_pages,(v_result->>'userId')::uuid,p_expires_at) THEN
  RAISE EXCEPTION 'Only the creator can change an email account expiry' USING ERRCODE='42501';
 END IF;
 RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.tokko_email_login_record(TEXT),
 public.tokko_assert_manager(UUID,UUID[]),
 public.tokko_set_member_expiry(UUID,UUID[],UUID,TIMESTAMPTZ),
 public.tokko_provision_member_with_expiry(UUID,UUID[],TEXT,TEXT,UUID,TEXT,TEXT,TEXT,BOOLEAN,TIMESTAMPTZ)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tokko_email_login_record(TEXT),
 public.tokko_assert_manager(UUID,UUID[]),
 public.tokko_set_member_expiry(UUID,UUID[],UUID,TIMESTAMPTZ),
 public.tokko_provision_member_with_expiry(UUID,UUID[],TEXT,TEXT,UUID,TEXT,TEXT,TEXT,BOOLEAN,TIMESTAMPTZ)
 TO service_role;
INSERT INTO app_private.schema_migrations(version,description)
 VALUES('20261030_001','Original Facebook Page administration and optional email account expiry') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
