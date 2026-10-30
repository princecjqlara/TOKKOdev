-- FINALIZER. First deploy the compatible application and review shared clients.
-- Password creation/assignment need no email sender. Configure email only for
-- invitations/recovery, and CRON_SECRET for HTTP workers if using those workers.
-- No user identities, Page grants, contacts, tags, or campaigns are deleted.
DO $$
DECLARE r RECORD;
BEGIN
 IF to_regclass('public.tokko_account_config') IS NULL THEN RAISE EXCEPTION 'Run migration_page_member_accounts.sql first'; END IF;
 -- The shared database also holds Page chatbot state and credentials. An
 -- allowlist of only Tokko's visible screens would leave that data exposed.
 FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public'
 LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',r.tablename);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated',r.tablename);
  EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role',r.tablename);
 END LOOP;
 FOR r IN SELECT viewname FROM pg_views WHERE schemaname='public' LOOP
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',r.viewname);
  EXECUTE format('GRANT SELECT ON public.%I TO service_role',r.viewname);
 END LOOP;
 FOR r IN SELECT matviewname FROM pg_matviews WHERE schemaname='public' LOOP
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',r.matviewname);
  EXECUTE format('GRANT SELECT ON public.%I TO service_role',r.matviewname);
 END LOOP;
 -- Administrative RPCs must not provide a side door around table policies.
 FOR r IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef
 LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',r.signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.signature);
 END LOOP;
END $$;

-- Retire the known historical seed. Preserve any replacement credential that
-- an administrator has deliberately installed; it is not enabled for email login.
UPDATE public.users SET password_hash=NULL,email_login_enabled=FALSE,session_version=session_version+1
WHERE email='admin@tokko.local' AND password_hash='$2a$10$3euPcmQFCibsmXK6jnNgXuRfxAzCmW3Rf0H.SrNMLlLbFfLs.OYTC';

UPDATE public.tokko_account_config SET enabled=TRUE WHERE id;
DO $$ BEGIN IF NOT public.tokko_accounts_ready() THEN RAISE EXCEPTION 'Page isolation checks failed'; END IF; END $$;
INSERT INTO app_private.schema_migrations(version,description) VALUES('20261026_003','Enforce Page data isolation and enable manager-provisioned accounts') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
