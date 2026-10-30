-- Apply after migration_page_member_accounts.sql, before deploying recovery code.
-- Facebook login does not depend on email-account feature activation.
CREATE OR REPLACE FUNCTION public.tokko_recover_legacy_facebook_login(
 p_subject TEXT,p_email TEXT,p_name TEXT,p_image TEXT,p_facebook_pages TEXT[])
RETURNS TABLE(user_id UUID,version INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user users%ROWTYPE;
BEGIN
 IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 100 OR p_email IS NULL THEN RETURN; END IF;
 IF lower(btrim(p_email)) LIKE '%@facebook.local'
  AND lower(btrim(p_email))<>lower('fb_'||p_subject||'@facebook.local') THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('facebook:'||p_subject,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('account-email:'||lower(btrim(p_email)),0));
 SELECT * INTO v_user FROM users WHERE lower(btrim(email))=lower(btrim(p_email)) FOR UPDATE;
 -- Never attach a Facebook login to an invitation, password account, inactive
 -- account, or an identity that has already been bound to another subject.
 IF NOT FOUND OR NOT v_user.is_active OR v_user.account_kind<>'legacy'
  OR (to_jsonb(v_user)->>'expires_at')::timestamptz<=now()
  OR v_user.created_by IS NOT NULL OR v_user.facebook_id IS NOT NULL
  OR v_user.password_hash IS NOT NULL OR v_user.email_login_enabled
  OR EXISTS(SELECT 1 FROM tokko_auth_identities i WHERE i.user_id=v_user.id OR (i.provider='facebook' AND i.subject=p_subject)) THEN RETURN; END IF;
 -- A reserved address generated from this exact authenticated Facebook subject
 -- is independent identity proof for old logins where Facebook supplied no email.
 -- For ordinary email addresses, the server passes IDs returned with MANAGE
 -- permission. Require ALL assignments, not just one shared Page. Email alone
 -- never establishes ownership. The checks and binding share one transaction.
 IF lower(btrim(p_email))<>lower('fb_'||p_subject||'@facebook.local') AND (
  NOT EXISTS(SELECT 1 FROM user_pages up WHERE up.user_id=v_user.id) OR EXISTS(
  SELECT 1 FROM user_pages up JOIN pages p ON p.id=up.page_id WHERE up.user_id=v_user.id
  AND (up.grant_source NOT IN ('legacy','facebook') OR p.fb_page_id IS NULL OR NOT p.fb_page_id=ANY(COALESCE(p_facebook_pages,'{}'::text[]))))) THEN RETURN; END IF;
 INSERT INTO tokko_access_audit(actor_id,user_id,action) VALUES(v_user.id,v_user.id,'legacy_facebook_login_recovered');
 RETURN QUERY SELECT * FROM tokko_resolve_facebook_user(p_subject,p_email,p_name,p_image,v_user.id);
END $$;
REVOKE ALL ON FUNCTION public.tokko_recover_legacy_facebook_login(TEXT,TEXT,TEXT,TEXT,TEXT[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tokko_recover_legacy_facebook_login(TEXT,TEXT,TEXT,TEXT,TEXT[]) TO service_role;
INSERT INTO app_private.schema_migrations(version,description)
 VALUES('20261030_002','Recover original Facebook accounts through verified Page management') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
