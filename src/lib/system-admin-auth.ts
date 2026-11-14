import { takeAccountRateLimit } from './account-auth';
import { AccessError, digest, normalizeEmail, verifyAccountPassword } from './account-security';
import { getSupabaseAdmin } from './supabase';
import { accountRequest } from './account-request';

export const SYSTEM_ADMIN_PROVIDER = 'system-admin';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

async function configuration() {
    let hash: unknown = process.env.SYSTEM_ADMIN_PASSWORD_HASH;
    let address: unknown = process.env.SYSTEM_ADMIN_EMAIL;
    let revision = 'environment';
    // Explicit environment configuration takes precedence, including invalid
    // values. Only an unconfigured host uses the protected database record.
    if (!address && !hash) {
        const { data, error } = await accountRequest(getSupabaseAdmin().rpc('tokko_system_admin_credentials'));
        if (error) throw new AccessError(503, 'Administrator sign-in is temporarily unavailable.');
        const row = Array.isArray(data) ? data[0] : null;
        if (!row || typeof row.revision !== 'string') return null;
        address = row.email; hash = row.password_hash; revision = row.revision;
    }
    let email: string;
    try { email = normalizeEmail(address); } catch { return null; }
    if (typeof hash !== 'string' || !/^scrypt-v1\$[a-f0-9]{48}\$[a-f0-9]{128}$/.test(hash)) return null;
    return { email, hash, version: digest(`tokko-admin-v1:${revision}:${email}:${hash}`) };
}

export async function authenticateSystemAdmin(credentials: Record<string, unknown> | undefined, ip: string) {
    // Shared database limits also apply to unknown addresses and across workers.
    await takeAccountRateLimit(`system-admin-ip:${ip}`, 30, 900);
    await takeAccountRateLimit('system-admin-login', 20, 900);
    const config = await configuration();
    let email = '';
    try { email = normalizeEmail(credentials?.email); } catch { /* Use the same password work for invalid input. */ }
    const matches = await verifyAccountPassword(credentials?.password, config?.hash);
    if (!config || !matches || email !== config.email) return null;
    return { id: 'tokko-system-admin', name: 'System administrator', email: config.email,
        adminCredentialVersion: config.version };
}

export async function systemAdminSessionActive(version: unknown, authenticatedAt: unknown, now = Date.now()) {
    if (typeof authenticatedAt !== 'number' || !Number.isFinite(authenticatedAt)
        || authenticatedAt > now || now - authenticatedAt >= SESSION_DURATION_MS) return false;
    const config = await configuration();
    return Boolean(config && version === config.version);
}
