-- Additive first-login onboarding for team subaccounts only.
-- Existing active accounts and original Facebook users keep their access.
ALTER TABLE public.users
 ADD COLUMN IF NOT EXISTS phone_number TEXT,
 ADD COLUMN IF NOT EXISTS profile_required BOOLEAN NOT NULL DEFAULT FALSE,
 ADD COLUMN IF NOT EXISTS profile_completed_at TIMESTAMPTZ;

-- Pending invitations have never signed in. They complete the same first-login
-- step as newly created password accounts after activating their credentials.
UPDATE public.users SET profile_required=TRUE
 WHERE account_kind='invited' AND NOT is_active AND profile_completed_at IS NULL AND NOT profile_required;

CREATE OR REPLACE FUNCTION public.tokko_require_subaccount_profile() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NEW.created_by IS NOT NULL OR NEW.account_kind IN ('email','invited') THEN
  NEW.profile_required:=TRUE;
  NEW.profile_completed_at:=NULL;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tokko_subaccount_first_login_profile ON public.users;
CREATE TRIGGER tokko_subaccount_first_login_profile BEFORE INSERT ON public.users
 FOR EACH ROW EXECUTE FUNCTION public.tokko_require_subaccount_profile();

CREATE OR REPLACE FUNCTION public.tokko_complete_subaccount_profile(
 p_user UUID,p_version INTEGER,p_name TEXT,p_phone TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user users%ROWTYPE;
BEGIN
 IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 100 OR p_name ~ '[[:cntrl:]]'
  OR p_phone IS NULL OR p_phone !~ '^\+[1-9][0-9]{7,14}$' THEN
  RAISE EXCEPTION 'Enter a valid name and phone number' USING ERRCODE='22023';
 END IF;
 SELECT * INTO v_user FROM users WHERE id=p_user FOR UPDATE;
 IF NOT FOUND OR v_user.is_active IS NOT TRUE OR v_user.session_version IS DISTINCT FROM p_version
  OR NOT v_user.email_login_enabled OR v_user.email_verified_at IS NULL
  OR (v_user.expires_at IS NOT NULL AND v_user.expires_at<=now())
  OR NOT v_user.profile_required
  OR (v_user.created_by IS NULL AND v_user.account_kind NOT IN ('email','invited')) THEN RETURN FALSE; END IF;
 -- A repeated submission cannot replace the details entered on the first save.
 IF v_user.profile_completed_at IS NOT NULL THEN RETURN TRUE; END IF;
 UPDATE users SET name=btrim(p_name),phone_number=p_phone,profile_completed_at=now(),updated_at=now() WHERE id=p_user;
 RETURN TRUE;
END $$;
REVOKE ALL ON FUNCTION public.tokko_require_subaccount_profile(),public.tokko_complete_subaccount_profile(UUID,INTEGER,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tokko_require_subaccount_profile(),public.tokko_complete_subaccount_profile(UUID,INTEGER,TEXT,TEXT) TO service_role;
INSERT INTO app_private.schema_migrations(version,description)
 VALUES('20261031_001','First-login name and phone details for new team subaccounts') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
