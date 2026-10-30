-- Install after migration_parent_subaccounts.sql. The database scheduler makes
-- deletion independent of account email delivery or an open browser session.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
  PERFORM cron.schedule('tokko-expired-subaccounts','* * * * *','SELECT public.tokko_delete_expired_subaccounts(100);');
 ELSE
  RAISE NOTICE 'Schedule authenticated GET /api/cron/subaccounts every minute.';
 END IF;
END $$;
INSERT INTO app_private.schema_migrations(version,description)
 VALUES('20261030_006','Schedule temporary subaccount cleanup every minute') ON CONFLICT(version) DO NOTHING;
