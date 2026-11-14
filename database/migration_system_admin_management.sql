-- Additive rollout after migration_system_admin.sql; older deployments keep
-- their original overview RPC until the updated application is deployed.
BEGIN;
CREATE OR REPLACE FUNCTION public.tokko_admin_accounts_v2(
 p_search TEXT DEFAULT '',p_type TEXT DEFAULT 'all',p_lifetime TEXT DEFAULT 'all',
 p_status TEXT DEFAULT 'all',p_page INTEGER DEFAULT 1,p_page_size INTEGER DEFAULT 25,p_parent UUID DEFAULT NULL,
 p_page_id UUID DEFAULT NULL,p_assignment TEXT DEFAULT 'all',p_expires_within INTEGER DEFAULT NULL,
 p_deletion TEXT DEFAULT 'all',p_password TEXT DEFAULT 'all',p_sort TEXT DEFAULT 'newest')
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_result JSONB;
BEGIN
 IF p_search IS NULL OR length(p_search)>100 OR p_type IS NULL OR p_type NOT IN ('all','parent','subaccount')
  OR p_lifetime IS NULL OR p_lifetime NOT IN ('all','permanent','temporary')
  OR p_status IS NULL OR p_status NOT IN ('all','active','disabled','pending','expired')
  OR p_page IS NULL OR p_page NOT BETWEEN 1 AND 100000 OR p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 100
  OR p_assignment IS NULL OR p_assignment NOT IN ('all','assigned','unassigned')
  OR (p_expires_within IS NOT NULL AND p_expires_within NOT IN (7,30,90))
  OR p_deletion IS NULL OR p_deletion NOT IN ('all','scheduled','keep')
  OR p_password IS NULL OR p_password NOT IN ('all','set','unset')
  OR p_sort IS NULL OR p_sort NOT IN ('newest','oldest','name','expiry')
 THEN RAISE EXCEPTION 'Invalid account filters' USING ERRCODE='22023'; END IF;
 WITH accounts AS (
  SELECT u.*,
   CASE WHEN u.created_by IS NULL AND u.account_kind IN ('facebook','legacy') THEN 'parent' ELSE 'subaccount' END AS account_type,
   CASE WHEN u.expires_at<=now() THEN 'expired' WHEN NOT u.is_active AND u.account_kind='invited' THEN 'pending'
    WHEN NOT u.is_active THEN 'disabled' ELSE 'active' END AS account_status
  FROM users u WHERE u.account_kind<>'system'
 ), filtered AS (
  SELECT u.* FROM accounts u
  WHERE (p_type='all' OR u.account_type=p_type)
   AND (p_lifetime='all' OR (p_lifetime='permanent' AND u.expires_at IS NULL) OR (p_lifetime='temporary' AND u.expires_at IS NOT NULL))
   AND (p_status='all' OR u.account_status=p_status) AND (p_parent IS NULL OR u.created_by=p_parent)
   AND (p_page_id IS NULL OR EXISTS(SELECT 1 FROM user_pages up WHERE up.user_id=u.id AND up.page_id=p_page_id))
   AND (p_assignment='all' OR (p_assignment='assigned' AND EXISTS(SELECT 1 FROM user_pages up WHERE up.user_id=u.id))
    OR (p_assignment='unassigned' AND NOT EXISTS(SELECT 1 FROM user_pages up WHERE up.user_id=u.id)))
   AND (p_expires_within IS NULL OR (u.expires_at>now() AND u.expires_at<=now()+make_interval(days=>p_expires_within)))
   AND (p_deletion='all' OR (p_deletion='scheduled' AND u.delete_after_expiry) OR (p_deletion='keep' AND NOT u.delete_after_expiry))
   AND (p_password='all' OR (p_password='set' AND u.password_hash IS NOT NULL) OR (p_password='unset' AND u.password_hash IS NULL))
   AND (p_search='' OR strpos(lower(coalesce(u.name,'')||' '||coalesce(u.email,'')||' '||u.id::text),lower(p_search))>0
    OR EXISTS(SELECT 1 FROM users c WHERE c.id=u.created_by AND strpos(lower(coalesce(c.name,'')||' '||coalesce(c.email,'')),lower(p_search))>0)
    OR EXISTS(SELECT 1 FROM user_pages up JOIN pages p ON p.id=up.page_id WHERE up.user_id=u.id
     AND strpos(lower(p.name||' '||p.fb_page_id),lower(p_search))>0))
 ), selected AS (
  SELECT u.*,row_number() OVER(ORDER BY
   CASE WHEN p_sort='newest' THEN u.created_at END DESC NULLS LAST,
   CASE WHEN p_sort='oldest' THEN u.created_at END ASC NULLS LAST,
   CASE WHEN p_sort='name' THEN lower(coalesce(u.name,u.email,'')) END ASC,
   CASE WHEN p_sort='expiry' THEN u.expires_at END ASC NULLS LAST,u.id) ordinal
  FROM filtered u ORDER BY ordinal LIMIT p_page_size OFFSET (p_page-1)*p_page_size
 ), rendered AS (
  SELECT u.ordinal,jsonb_build_object(
   'id',u.id,'name',u.name,'email',u.email,'type',u.account_type,'kind',u.account_kind,'active',u.is_active,
   'status',u.account_status,'createdAt',u.created_at,'phone',u.phone_number,'expiresAt',u.expires_at,
   'daysRemaining',CASE WHEN u.expires_at IS NULL THEN NULL ELSE greatest(0,ceil(extract(epoch FROM (u.expires_at-now()))/86400)) END,
   'lifetimeDays',CASE WHEN u.expires_at IS NULL THEN NULL ELSE greatest(0,ceil(extract(epoch FROM (u.expires_at-u.created_at))/86400)) END,
   'deleteAfterExpiry',u.delete_after_expiry,'emailLoginEnabled',u.email_login_enabled,'emailVerifiedAt',u.email_verified_at,
   'hasPassword',u.password_hash IS NOT NULL,'passwordChangedAt',u.password_changed_at,
   'canResetPassword',u.account_kind='email' AND u.created_by IS NOT NULL AND u.facebook_id IS NULL
    AND u.email_login_enabled AND u.email_verified_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tokko_auth_identities i WHERE i.user_id=u.id),
   'canEnable',u.account_kind<>'invited' AND (u.account_kind<>'email' OR (u.email_login_enabled AND u.email_verified_at IS NOT NULL AND u.password_hash IS NOT NULL)),
   'canDelete',NOT EXISTS(SELECT 1 FROM users c WHERE c.created_by=u.id),
   'canScheduleDeletion',u.created_by IS NOT NULL AND u.account_kind IN ('email','invited') AND u.facebook_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM tokko_auth_identities i WHERE i.user_id=u.id),
   'creator',(SELECT jsonb_build_object('id',c.id,'name',c.name,'email',c.email) FROM users c WHERE c.id=u.created_by),
   'subaccountCount',(SELECT count(*) FROM users c WHERE c.created_by=u.id AND c.account_kind<>'system'),
   'pages',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'facebookId',p.fb_page_id,
    'assignedAt',up.created_at,'source',up.grant_source,
    'assignedBy',CASE WHEN g.id IS NULL THEN NULL ELSE jsonb_build_object('id',g.id,'name',g.name,'email',g.email) END) ORDER BY p.name,p.id)
    FROM user_pages up JOIN pages p ON p.id=up.page_id LEFT JOIN users g ON g.id=up.granted_by WHERE up.user_id=u.id),'[]'::jsonb)
  ) account FROM selected u
 ) SELECT jsonb_build_object(
  'accounts',coalesce((SELECT jsonb_agg(account ORDER BY ordinal) FROM rendered),'[]'::jsonb),
  'total',(SELECT count(*) FROM filtered),'page',p_page,'pageSize',p_page_size,
  'summary',(SELECT jsonb_build_object('accounts',count(*),'parents',count(*) FILTER(WHERE account_type='parent'),
   'subaccounts',count(*) FILTER(WHERE account_type='subaccount'),'permanent',count(*) FILTER(WHERE expires_at IS NULL),
   'temporary',count(*) FILTER(WHERE expires_at IS NOT NULL),'expired',count(*) FILTER(WHERE account_status='expired')) FROM accounts),
  'filterOptions',jsonb_build_object(
   'creators',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'email',c.email) ORDER BY lower(coalesce(c.name,c.email,'')),c.id)
    FROM users c WHERE c.account_kind<>'system' AND EXISTS(SELECT 1 FROM accounts u WHERE u.created_by=c.id)),'[]'::jsonb),
   'pages',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.name) ORDER BY p.name,p.id) FROM pages p),'[]'::jsonb))
 ) INTO v_result;
 RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_admin_set_account_active(p_user UUID,p_active BOOLEAN,p_admin_email TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user users%ROWTYPE;
BEGIN
 IF p_active IS NULL OR p_admin_email IS NULL OR length(p_admin_email) NOT BETWEEN 3 AND 254
 THEN RAISE EXCEPTION 'Invalid account update' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_user FROM users WHERE id=p_user FOR UPDATE;
 IF NOT FOUND OR v_user.account_kind='system' THEN RETURN FALSE; END IF;
 IF p_active AND (v_user.account_kind='invited' OR (v_user.account_kind='email'
  AND (NOT v_user.email_login_enabled OR v_user.email_verified_at IS NULL OR v_user.password_hash IS NULL)))
 THEN RAISE EXCEPTION 'Password setup must be completed before enabling this account' USING ERRCODE='22023'; END IF;
 IF v_user.is_active IS DISTINCT FROM p_active THEN
  UPDATE users SET is_active=p_active,session_version=session_version+1,updated_at=now() WHERE id=p_user;
  INSERT INTO tokko_access_audit(user_id,action) VALUES(p_user,
   CASE WHEN p_active THEN 'system_admin_account_enabled:' ELSE 'system_admin_account_disabled:' END||lower(btrim(p_admin_email)));
 END IF;
 RETURN TRUE;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_admin_set_account_lifetime(
 p_user UUID,p_expiry_set BOOLEAN,p_expires_at TIMESTAMPTZ,p_lifetime_days INTEGER,p_delete_after_expiry BOOLEAN,p_admin_email TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user users%ROWTYPE; v_deadline TIMESTAMPTZ; v_delete BOOLEAN;
BEGIN
 IF p_admin_email IS NULL OR length(p_admin_email) NOT BETWEEN 3 AND 254 OR p_expiry_set IS NULL
  OR (p_lifetime_days IS NOT NULL AND (p_lifetime_days NOT BETWEEN 1 AND 3650 OR p_expiry_set))
 THEN RAISE EXCEPTION 'Invalid lifetime' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_user FROM users WHERE id=p_user FOR UPDATE;
 IF NOT FOUND OR v_user.account_kind='system' THEN RETURN FALSE; END IF;
 v_deadline:=CASE WHEN p_lifetime_days IS NOT NULL THEN now()+make_interval(days=>p_lifetime_days)
  WHEN p_expiry_set THEN p_expires_at ELSE v_user.expires_at END;
 v_delete:=coalesce(p_delete_after_expiry,v_user.delete_after_expiry);
 IF v_deadline IS NOT NULL AND v_deadline<=now() THEN RAISE EXCEPTION 'Choose a future deadline' USING ERRCODE='22023'; END IF;
 IF p_delete_after_expiry IS TRUE AND v_deadline IS NULL THEN RAISE EXCEPTION 'Scheduled deletion requires a deadline' USING ERRCODE='22023'; END IF;
 IF v_deadline IS NULL THEN v_delete:=FALSE; END IF;
 IF v_delete AND (v_user.created_by IS NULL OR v_user.account_kind NOT IN ('email','invited') OR v_user.facebook_id IS NOT NULL
  OR EXISTS(SELECT 1 FROM tokko_auth_identities WHERE user_id=p_user))
 THEN RAISE EXCEPTION 'Only email subaccounts support scheduled deletion' USING ERRCODE='22023'; END IF;
 UPDATE users SET expires_at=v_deadline,delete_after_expiry=v_delete,updated_at=now() WHERE id=p_user;
 INSERT INTO tokko_access_audit(user_id,action) VALUES(p_user,'system_admin_lifetime_updated:'||lower(btrim(p_admin_email)));
 RETURN TRUE;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_admin_delete_account(p_user UUID,p_confirmation TEXT,p_admin_email TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user users%ROWTYPE; v_marker UUID:='00000000-0000-4000-8000-000000000001';
BEGIN
 IF p_admin_email IS NULL OR length(p_admin_email) NOT BETWEEN 3 AND 254
 THEN RAISE EXCEPTION 'Invalid administrator' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_user FROM users WHERE id=p_user FOR UPDATE;
 IF NOT FOUND OR v_user.account_kind='system' THEN RETURN FALSE; END IF;
 IF p_confirmation IS NULL OR lower(btrim(p_confirmation))<>lower(coalesce(nullif(btrim(v_user.email),''),v_user.id::text))
 THEN RAISE EXCEPTION 'Type the account email or ID to confirm deletion' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM users WHERE created_by=p_user)
 THEN RAISE EXCEPTION 'Delete subaccounts before deleting their parent' USING ERRCODE='23503'; END IF;
 -- Keep shared records and non-null audit authors after deleting the login.
 INSERT INTO users(id,name,is_active,email_login_enabled,account_kind)
  VALUES(v_marker,'Deleted team member',FALSE,FALSE,'system') ON CONFLICT(id) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM users WHERE id=v_marker AND account_kind='system' AND NOT is_active
  AND NOT email_login_enabled AND email IS NULL AND facebook_id IS NULL AND password_hash IS NULL)
 THEN RAISE EXCEPTION 'Deleted-user marker unavailable' USING ERRCODE='55000'; END IF;
 IF to_regclass('public.conversation_export_jobs') IS NOT NULL THEN
  EXECUTE 'UPDATE public.conversation_export_jobs SET created_by=$1 WHERE created_by=$2' USING coalesce(v_user.created_by,v_marker),p_user;
 END IF;
 IF to_regclass('public.contact_bot_permission_events') IS NOT NULL THEN
  EXECUTE 'UPDATE public.contact_bot_permission_events SET actor_id=$1 WHERE actor_id=$2' USING v_marker,p_user;
 END IF;
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='businesses' AND column_name='created_by') THEN
  EXECUTE 'UPDATE public.businesses SET created_by=NULL WHERE created_by=$1' USING p_user;
 END IF;
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='campaigns' AND column_name='created_by') THEN
  EXECUTE 'UPDATE public.campaigns SET created_by=NULL WHERE created_by=$1' USING p_user;
 END IF;
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tags' AND column_name='owner_type') THEN
  EXECUTE 'DELETE FROM public.tags WHERE owner_type=''user'' AND owner_id=$1' USING p_user;
 END IF;
 INSERT INTO tokko_access_audit(user_id,action) VALUES(p_user,'system_admin_account_deleted:'||p_user::text||':'||lower(btrim(p_admin_email)));
 DELETE FROM users WHERE id=p_user;
 RETURN TRUE;
END $$;

REVOKE ALL ON FUNCTION public.tokko_admin_accounts_v2(TEXT,TEXT,TEXT,TEXT,INTEGER,INTEGER,UUID,UUID,TEXT,INTEGER,TEXT,TEXT,TEXT),
 public.tokko_admin_set_account_active(UUID,BOOLEAN,TEXT),
 public.tokko_admin_set_account_lifetime(UUID,BOOLEAN,TIMESTAMPTZ,INTEGER,BOOLEAN,TEXT),
 public.tokko_admin_delete_account(UUID,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tokko_admin_accounts_v2(TEXT,TEXT,TEXT,TEXT,INTEGER,INTEGER,UUID,UUID,TEXT,INTEGER,TEXT,TEXT,TEXT),
 public.tokko_admin_set_account_active(UUID,BOOLEAN,TEXT),
 public.tokko_admin_set_account_lifetime(UUID,BOOLEAN,TIMESTAMPTZ,INTEGER,BOOLEAN,TEXT),
 public.tokko_admin_delete_account(UUID,TEXT,TEXT) TO service_role;
INSERT INTO app_private.schema_migrations(version,description)
 VALUES('20261114_003','Administrator account deletion, status and lifetime controls, and extended account filters') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
