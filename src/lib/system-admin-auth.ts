import { takeAccountRateLimit } from './account-auth';
import { digest, normalizeEmail, verifyAccountPassword } from './account-security';

export const SYSTEM_ADMIN_PROVIDER = 'system-admin';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

function configuration() {
    const hash = process.env.SYSTEM_ADMIN_PASSWORD_HASH;
    let email: string;
    try { email = normalizeEmail(process.env.SYSTEM_ADMIN_EMAIL); } catch { return null; }
    if (!hash || !/^scrypt-v1\$[a-f0-9]{48}\$[a-f0-9]{128}$/.test(hash)) return null;
    return { email, hash, version: digest(`tokko-admin-v1:${email}:${hash}`) };
}

export async function authenticateSystemAdmin(credentials: Record<string, unknown> | undefined, ip: string) {
    // Shared database limits also apply to unknown addresses and across workers.
    await takeAccountRateLimit(`system-admin-ip:${ip}`, 30, 900);
    await takeAccountRateLimit('system-admin-login', 20, 900);
    const config = configuration();
    let email = '';
    try { email = normalizeEmail(credentials?.email); } catch { /* Use the same password work for invalid input. */ }
    const matches = await verifyAccountPassword(credentials?.password, config?.hash);
    if (!config || !matches || email !== config.email) return null;
    return { id: 'tokko-system-admin', name: 'System administrator', email: config.email,
        adminCredentialVersion: config.version };
}

export function systemAdminSessionActive(version: unknown, authenticatedAt: unknown, now = Date.now()) {
    const config = configuration();
    return Boolean(config && version === config.version && typeof authenticatedAt === 'number'
        && Number.isFinite(authenticatedAt) && authenticatedAt <= now && now - authenticatedAt < SESSION_DURATION_MS);
}
