-- Run after migration_facebook_messaging_access.sql. Original Facebook parents
-- can assign any Page already connected to their Tokko account, including Pages
-- connected through messaging tasks. This changes no memberships or Page tokens.
-- Connecting/refreshing shared tokens still uses the separate Meta role checks.
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
REVOKE ALL ON FUNCTION public.tokko_assert_manager(UUID,UUID[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tokko_assert_manager(UUID,UUID[]) TO service_role;
INSERT INTO app_private.schema_migrations(version,description)
 VALUES('20261108_001','Allow original Facebook parents to assign all of their connected Pages')
 ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
