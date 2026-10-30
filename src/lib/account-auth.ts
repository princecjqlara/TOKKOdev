import { getSupabaseAdmin } from './supabase';
import { AccessError, digest, normalizeEmail, verifyAccountPassword } from './account-security';
import { accountHasExpired } from './account-expiry';

export async function takeAccountRateLimit(bucket: string, limit: number, seconds: number) {
    const { data, error } = await getSupabaseAdmin().rpc('tokko_take_auth_limit', {
        p_bucket: digest(bucket), p_limit: limit, p_seconds: seconds
    });
    if (error) throw new AccessError(503, 'Account service is temporarily unavailable.');
    if (data !== true) throw new AccessError(429, 'Too many attempts. Please try again later.');
}

export async function accountsReady(): Promise<boolean> {
    const { data, error } = await getSupabaseAdmin().rpc('tokko_accounts_ready');
    return !error && data === true;
}

export async function authenticateEmail(credentials: Record<string, unknown> | undefined, ip = 'unknown') {
    if (!await accountsReady()) return null;
    let email: string;
    try { email = normalizeEmail(credentials?.email); } catch { email = ''; }
    await takeAccountRateLimit(`login-ip:${ip}`, 40, 900);
    await takeAccountRateLimit(`login-email:${email}`, 10, 900);
    // Use an exact normalized comparison in SQL; PostgREST ilike patterns can
    // reinterpret unusual but valid email characters as wildcards.
    const { data: rows, error } = email ? await getSupabaseAdmin().rpc('tokko_email_login_record', { p_email: email }) : { data: null, error: null };
    const user = Array.isArray(rows) ? rows[0] : rows;
    if (error) throw new AccessError(503, 'Sign-in is temporarily unavailable.');
    const matches = await verifyAccountPassword(credentials?.password, user?.password_hash);
    if (!matches || !user?.is_active || !user.email_login_enabled || !user.email_verified_at || accountHasExpired(user.expires_at)) return null;
    return { id: user.id as string, name: user.name, email: user.email, image: user.image, sessionVersion: Number(user.session_version) };
}

export async function getActiveAccount(id: string, version: number, provider: string) {
    const db = getSupabaseAdmin();
    const profileColumns = ['phone_number', 'profile_required', 'profile_completed_at'];
    let columns = ['id', 'name', 'is_active', 'session_version', 'email_login_enabled', 'email_verified_at', 'expires_at', 'created_by', 'account_kind', ...profileColumns];
    let data: Record<string, any> | null = null;
    let error: { code?: string; message?: string } | null = null;
    // Additive migrations can follow an older Facebook-only deployment. Retry
    // only known optional columns; other failures continue to deny access.
    for (let attempt = 0; attempt < 3; attempt++) {
        const result = await db.from('users').select(columns.join(',')).eq('id', id).maybeSingle();
        data = result.data; error = result.error;
        const missing = error?.code === '42703' ? /column (?:users\.)?(expires_at|phone_number|profile_required|profile_completed_at) does not exist/.exec(error.message || '')?.[1] : null;
        if (!missing) break;
        columns = columns.filter(column => missing === 'expires_at' ? column !== missing : !profileColumns.includes(column));
    }
    if (error) throw new AccessError(503, 'Sign-in is temporarily unavailable.');
    if (!data?.is_active || Number(data.session_version) !== version || accountHasExpired(data.expires_at)) return null;
    if (provider === 'facebook' && (data.created_by || ['email', 'invited'].includes(data.account_kind))) return null;
    if (provider === 'credentials' && (!data.email_login_enabled || !data.email_verified_at || !await accountsReady())) return null;
    return data;
}
