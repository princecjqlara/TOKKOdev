-- Restore the original Facebook-only account path. Run after account preparation.
-- Only trusted server-side Facebook OAuth callbacks call this service-only RPC.
CREATE OR REPLACE FUNCTION public.tokko_resolve_facebook_user(p_subject TEXT,p_email TEXT,p_name TEXT,p_image TEXT,p_legacy_id UUID DEFAULT NULL)
RETURNS TABLE(user_id UUID,version INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user users%ROWTYPE; v_email TEXT:=COALESCE(NULLIF(lower(btrim(p_email)),''),'fb_'||p_subject||'@facebook.local');
BEGIN
 IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid Facebook identity'; END IF;
 IF v_email LIKE '%@facebook.local' AND v_email<>('fb_'||p_subject||'@facebook.local') THEN
  RAISE EXCEPTION 'Facebook identity requires administrator review' USING ERRCODE='28000';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('facebook:'||p_subject,0));
 SELECT u.* INTO v_user FROM users u JOIN tokko_auth_identities i ON i.user_id=u.id
  WHERE i.provider='facebook' AND i.subject=p_subject FOR UPDATE OF u;
 IF v_user.id IS NULL THEN SELECT * INTO v_user FROM users WHERE facebook_id=p_subject FOR UPDATE; END IF;
 IF v_user.id IS NULL AND p_legacy_id IS NOT NULL THEN
  SELECT * INTO v_user FROM users WHERE id=p_legacy_id AND account_kind='legacy' AND created_by IS NULL
   AND NOT email_login_enabled AND password_hash IS NULL AND facebook_id IS NULL FOR UPDATE;
 END IF;
 IF v_user.id IS NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('account-email:'||v_email,0));
  SELECT * INTO v_user FROM users WHERE lower(btrim(email))=v_email FOR UPDATE;
  IF FOUND THEN
   -- Before subaccounts existed, Tokko stored its Facebook app-role users by
   -- provider email alone. Restore only those original, credential-free rows.
   -- Page MANAGE permission is unrelated to admission to the Facebook app.
   IF v_user.account_kind<>'legacy' OR v_user.created_by IS NOT NULL OR v_user.facebook_id IS NOT NULL
    OR v_user.password_hash IS NOT NULL OR v_user.email_login_enabled
    OR EXISTS(SELECT 1 FROM tokko_auth_identities i WHERE i.user_id=v_user.id) THEN
    -- Keep developer-invited parent identities separate from password users
    -- with the same email. Their credentials and Page assignments stay intact.
    v_email:='fb_'||p_subject||'@facebook.local';
    SELECT * INTO v_user FROM users WHERE lower(btrim(email))=v_email FOR UPDATE;
    IF FOUND THEN
     IF v_user.account_kind<>'legacy' OR v_user.created_by IS NOT NULL OR v_user.facebook_id IS NOT NULL
      OR v_user.password_hash IS NOT NULL OR v_user.email_login_enabled
      OR EXISTS(SELECT 1 FROM tokko_auth_identities i WHERE i.user_id=v_user.id) THEN
      RAISE EXCEPTION 'Facebook identity requires administrator review' USING ERRCODE='28000';
     END IF;
    ELSE
     INSERT INTO users(email,name,image,facebook_id,is_active,account_kind)
      VALUES(v_email,p_name,p_image,p_subject,TRUE,'facebook') RETURNING * INTO v_user;
    END IF;
   END IF;
  ELSE
   INSERT INTO users(email,name,image,facebook_id,is_active,account_kind)
    VALUES(v_email,p_name,p_image,p_subject,TRUE,'facebook') RETURNING * INTO v_user;
  END IF;
 END IF;
 IF v_user.created_by IS NOT NULL OR v_user.account_kind IN ('email','invited') THEN
  RAISE EXCEPTION 'Subaccounts use email and password' USING ERRCODE='28000';
 END IF;
 IF NOT v_user.is_active OR (to_jsonb(v_user)->>'expires_at')::timestamptz<=now() THEN
  RAISE EXCEPTION 'Account inactive or expired' USING ERRCODE='28000';
 END IF;
 INSERT INTO tokko_auth_identities(provider,subject,user_id) VALUES('facebook',p_subject,v_user.id) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM tokko_auth_identities i WHERE i.provider='facebook' AND i.subject=p_subject AND i.user_id=v_user.id) THEN RAISE EXCEPTION 'Identity mismatch'; END IF;
 UPDATE users SET facebook_id=p_subject,account_kind='facebook',
  name=COALESCE(p_name,name),image=p_image,updated_at=now() WHERE id=v_user.id;
 RETURN QUERY SELECT v_user.id,v_user.session_version;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_is_parent_user(p_user UUID,p_subject TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM users u JOIN tokko_auth_identities i ON i.user_id=u.id
  WHERE u.id=p_user AND u.created_by IS NULL AND u.account_kind IN ('legacy','facebook') AND u.is_active
  AND (to_jsonb(u)->>'expires_at' IS NULL OR (to_jsonb(u)->>'expires_at')::timestamptz>now())
  AND u.facebook_id=p_subject AND i.provider='facebook' AND i.subject=p_subject)
$$;
CREATE OR REPLACE FUNCTION public.tokko_guard_facebook_parent_identity() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM users u WHERE u.id=NEW.user_id AND u.created_by IS NULL AND u.account_kind IN ('legacy','facebook')) THEN
  RAISE EXCEPTION 'Subaccounts use email and password' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tokko_facebook_parent_identity ON public.tokko_auth_identities;
CREATE TRIGGER tokko_facebook_parent_identity BEFORE INSERT OR UPDATE ON public.tokko_auth_identities
 FOR EACH ROW EXECUTE FUNCTION public.tokko_guard_facebook_parent_identity();
REVOKE ALL ON FUNCTION public.tokko_resolve_facebook_user(TEXT,TEXT,TEXT,TEXT,UUID),public.tokko_is_parent_user(UUID,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tokko_resolve_facebook_user(TEXT,TEXT,TEXT,TEXT,UUID),public.tokko_is_parent_user(UUID,TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.tokko_guard_facebook_parent_identity() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tokko_guard_facebook_parent_identity() TO service_role;
INSERT INTO app_private.schema_migrations(version,description)
 VALUES('20261030_004','Restore original Facebook app users independently of Page management permission') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
