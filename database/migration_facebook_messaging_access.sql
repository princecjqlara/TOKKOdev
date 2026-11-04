-- Facebook messaging access authorizes workspace use without a Tokko invitation.
-- Keep that membership separate from existing parent/team administration grants.
-- Run after migration_parent_subaccounts.sql; existing memberships stay intact.
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
   WHERE m.user_id=p_actor AND m.page_id=selected.page_id AND m.verified_at>now()-interval '1 minute'
    AND up.grant_source<>'facebook_messaging'))
 THEN RAISE EXCEPTION 'Original Facebook parent account required' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.tokko_assert_manager(UUID,UUID[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tokko_assert_manager(UUID,UUID[]) TO service_role;
INSERT INTO app_private.schema_migrations(version,description)
 VALUES('20261104_002','Allow verified Facebook messaging Page use without granting team administration')
 ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
