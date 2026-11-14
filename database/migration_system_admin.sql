-- Run after the existing parent subaccount and first-login profile migrations.
-- Administrator authentication is configured on the server, separately from users.
BEGIN;

CREATE OR REPLACE FUNCTION public.tokko_admin_accounts(
 p_search TEXT DEFAULT '', p_type TEXT DEFAULT 'all', p_lifetime TEXT DEFAULT 'all',
 p_status TEXT DEFAULT 'all', p_page INTEGER DEFAULT 1, p_page_size INTEGER DEFAULT 25,
 p_parent UUID DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_result JSONB;
BEGIN
 IF p_search IS NULL OR length(p_search)>100 OR p_type NOT IN ('all','parent','subaccount') OR p_type IS NULL
  OR p_lifetime NOT IN ('all','permanent','temporary') OR p_lifetime IS NULL
  OR p_status NOT IN ('all','active','disabled','pending','expired') OR p_status IS NULL
  OR p_page IS NULL OR p_page NOT BETWEEN 1 AND 100000 OR p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 100
 THEN RAISE EXCEPTION 'Invalid account filters' USING ERRCODE='22023'; END IF;

 WITH accounts AS (
  SELECT u.*,
   CASE WHEN u.created_by IS NULL AND u.account_kind IN ('facebook','legacy') THEN 'parent' ELSE 'subaccount' END AS account_type,
   CASE WHEN u.expires_at<=now() THEN 'expired'
    WHEN NOT u.is_active AND u.account_kind='invited' THEN 'pending'
    WHEN NOT u.is_active THEN 'disabled' ELSE 'active' END AS account_status
  FROM users u WHERE u.account_kind<>'system'
 ), filtered AS (
  SELECT u.* FROM accounts u
  WHERE (p_type='all' OR u.account_type=p_type)
   AND (p_lifetime='all' OR (p_lifetime='permanent' AND u.expires_at IS NULL) OR (p_lifetime='temporary' AND u.expires_at IS NOT NULL))
   AND (p_status='all' OR u.account_status=p_status)
   AND (p_parent IS NULL OR u.created_by=p_parent)
   AND (p_search='' OR strpos(lower(coalesce(u.name,'')||' '||coalesce(u.email,'')||' '||u.id::text),lower(p_search))>0
    OR EXISTS(SELECT 1 FROM users creator WHERE creator.id=u.created_by
     AND strpos(lower(coalesce(creator.name,'')||' '||coalesce(creator.email,'')),lower(p_search))>0)
    OR EXISTS(SELECT 1 FROM user_pages up JOIN pages p ON p.id=up.page_id WHERE up.user_id=u.id
     AND strpos(lower(p.name||' '||p.fb_page_id),lower(p_search))>0))
 ), selected AS (
  SELECT * FROM filtered ORDER BY created_at DESC NULLS LAST,id LIMIT p_page_size OFFSET (p_page-1)*p_page_size
 ), rendered AS (
  SELECT u.created_at,u.id,jsonb_build_object(
   'id',u.id,'name',u.name,'email',u.email,'type',u.account_type,'kind',u.account_kind,
   'active',u.is_active,'status',u.account_status,'createdAt',u.created_at,'phone',u.phone_number,
   'expiresAt',u.expires_at,
   'daysRemaining',CASE WHEN u.expires_at IS NULL THEN NULL ELSE greatest(0,ceil(extract(epoch FROM (u.expires_at-now()))/86400)) END,
   'lifetimeDays',CASE WHEN u.expires_at IS NULL THEN NULL ELSE greatest(0,ceil(extract(epoch FROM (u.expires_at-u.created_at))/86400)) END,
   'deleteAfterExpiry',u.delete_after_expiry,'emailLoginEnabled',u.email_login_enabled,
   'emailVerifiedAt',u.email_verified_at,'hasPassword',u.password_hash IS NOT NULL,'passwordChangedAt',u.password_changed_at,
   'canResetPassword',u.account_kind='email' AND u.created_by IS NOT NULL AND u.facebook_id IS NULL
    AND u.email_login_enabled AND u.email_verified_at IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM tokko_auth_identities i WHERE i.user_id=u.id),
   'creator',(SELECT jsonb_build_object('id',c.id,'name',c.name,'email',c.email) FROM users c WHERE c.id=u.created_by),
   'subaccountCount',(SELECT count(*) FROM users child WHERE child.created_by=u.id AND child.account_kind<>'system'),
   'pages',coalesce((SELECT jsonb_agg(jsonb_build_object(
    'id',p.id,'name',p.name,'facebookId',p.fb_page_id,'assignedAt',up.created_at,'source',up.grant_source,
    'assignedBy',CASE WHEN grantor.id IS NULL THEN NULL ELSE jsonb_build_object('id',grantor.id,'name',grantor.name,'email',grantor.email) END)
    ORDER BY p.name,p.id)
    FROM user_pages up JOIN pages p ON p.id=up.page_id LEFT JOIN users grantor ON grantor.id=up.granted_by
    WHERE up.user_id=u.id),'[]'::jsonb)
  ) AS account FROM selected u
 )
 SELECT jsonb_build_object(
  'accounts',coalesce((SELECT jsonb_agg(account ORDER BY created_at DESC NULLS LAST,id) FROM rendered),'[]'::jsonb),
  'total',(SELECT count(*) FROM filtered),'page',p_page,'pageSize',p_page_size,
  'summary',(SELECT jsonb_build_object('accounts',count(*),'parents',count(*) FILTER(WHERE account_type='parent'),
   'subaccounts',count(*) FILTER(WHERE account_type='subaccount'),'permanent',count(*) FILTER(WHERE expires_at IS NULL),
   'temporary',count(*) FILTER(WHERE expires_at IS NOT NULL),'expired',count(*) FILTER(WHERE account_status='expired')) FROM accounts)
 ) INTO v_result;
 RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.tokko_admin_reset_subaccount_password(p_user UUID,p_password_hash TEXT,p_admin_email TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user users%ROWTYPE;
BEGIN
 IF p_password_hash IS NULL OR p_password_hash !~ '^scrypt-v1\$[a-f0-9]{48}\$[a-f0-9]{128}$'
  OR p_admin_email IS NULL OR length(p_admin_email) NOT BETWEEN 3 AND 254
 THEN RAISE EXCEPTION 'Invalid password reset' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_user FROM users WHERE id=p_user FOR UPDATE;
 IF NOT FOUND OR v_user.account_kind<>'email' OR v_user.created_by IS NULL OR v_user.facebook_id IS NOT NULL
  OR NOT v_user.email_login_enabled OR v_user.email_verified_at IS NULL
  OR EXISTS(SELECT 1 FROM tokko_auth_identities i WHERE i.user_id=p_user)
 THEN RETURN FALSE; END IF;
 UPDATE users SET password_hash=p_password_hash,password_changed_at=now(),session_version=session_version+1,updated_at=now() WHERE id=p_user;
 UPDATE tokko_account_tokens SET consumed_at=now() WHERE user_id=p_user AND consumed_at IS NULL;
 UPDATE tokko_account_mail SET status='cancelled',encrypted_token='',lease_until=NULL,claim_token=NULL
  WHERE token_id IN(SELECT id FROM tokko_account_tokens WHERE user_id=p_user) AND status IN ('pending','sending','failed');
 INSERT INTO tokko_access_audit(user_id,action) VALUES(p_user,'system_admin_password_reset:'||lower(btrim(p_admin_email)));
 RETURN TRUE;
END $$;

REVOKE ALL ON FUNCTION public.tokko_admin_accounts(TEXT,TEXT,TEXT,TEXT,INTEGER,INTEGER,UUID),
 public.tokko_admin_reset_subaccount_password(UUID,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tokko_admin_accounts(TEXT,TEXT,TEXT,TEXT,INTEGER,INTEGER,UUID),
 public.tokko_admin_reset_subaccount_password(UUID,TEXT,TEXT) TO service_role;

INSERT INTO app_private.schema_migrations(version,description)
 VALUES('20261114_001','Service-only system administrator account overview and audited subaccount password reset') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
