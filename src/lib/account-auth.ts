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
    let { data, error } = await db.from('users')
        .select('id,is_active,session_version,email_login_enabled,email_verified_at,expires_at')
        .eq('id', id).maybeSingle();
    // The optional expiry migration may follow a Facebook-only deployment.
    // Retry only this specific missing column; all other DB failures deny access.
    if (error?.code === '42703' && /column (?:users\.)?expires_at does not exist/.test(error.message || '')) {
        const legacy = await db.from('users').select('id,is_active,session_version,email_login_enabled,email_verified_at')
            .eq('id', id).maybeSingle();
        data = legacy.data ? { ...legacy.data, expires_at: null } : null;
        error = legacy.error;
    }
    if (error) throw new AccessError(503, 'Sign-in is temporarily unavailable.');
    if (!data?.is_active || Number(data.session_version) !== version || accountHasExpired(data.expires_at)) return null;
    if (provider === 'credentials' && (!data.email_login_enabled || !data.email_verified_at || !await accountsReady())) return null;
    return data;
}
