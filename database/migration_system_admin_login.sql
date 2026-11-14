-- Install after migration_system_admin.sql. Contains no account credentials.
BEGIN;
CREATE TABLE IF NOT EXISTS app_private.system_admin_config (
 id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(id),
 email TEXT NOT NULL CHECK(length(email) BETWEEN 3 AND 254),
 password_hash TEXT NOT NULL CHECK(password_hash ~ '^scrypt-v1\$[a-f0-9]{48}\$[a-f0-9]{128}$'),
 enabled BOOLEAN NOT NULL DEFAULT FALSE,
 revision UUID NOT NULL DEFAULT gen_random_uuid(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app_private.system_admin_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.system_admin_config FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION app_private.rotate_system_admin_revision() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 NEW.revision:=gen_random_uuid();
 NEW.updated_at:=now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.rotate_system_admin_revision() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS system_admin_revision ON app_private.system_admin_config;
CREATE TRIGGER system_admin_revision BEFORE UPDATE ON app_private.system_admin_config
 FOR EACH ROW EXECUTE FUNCTION app_private.rotate_system_admin_revision();

CREATE OR REPLACE FUNCTION public.tokko_system_admin_credentials()
RETURNS TABLE(email TEXT,password_hash TEXT,revision UUID)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT c.email,c.password_hash,c.revision FROM app_private.system_admin_config c WHERE c.id AND c.enabled
$$;
REVOKE ALL ON FUNCTION public.tokko_system_admin_credentials() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tokko_system_admin_credentials() TO service_role;

INSERT INTO app_private.schema_migrations(version,description)
 VALUES('20261114_002','Private database administrator credentials for hosts without environment configuration') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
