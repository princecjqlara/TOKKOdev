import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashAccountPassword } from '../account-security';
const mocks = vi.hoisted(() => ({ rate: vi.fn(), rpc: vi.fn() }));
vi.mock('../account-auth', () => ({ takeAccountRateLimit: mocks.rate }));
vi.mock('../supabase', () => ({ getSupabaseAdmin: () => ({ rpc: mocks.rpc }) }));
import { authenticateSystemAdmin, systemAdminSessionActive } from '../system-admin-auth';

let hash: string;
beforeAll(async () => { hash = await hashAccountPassword('test-admin-password'); });
beforeEach(() => {
    vi.clearAllMocks(); mocks.rate.mockResolvedValue(undefined);
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    vi.stubEnv('SYSTEM_ADMIN_EMAIL', 'admin@example.test'); vi.stubEnv('SYSTEM_ADMIN_PASSWORD_HASH', hash);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('separate administrator authentication', () => {
    it('requires both configured credentials and returns no password material', async () => {
        const user = await authenticateSystemAdmin({ email: ' ADMIN@example.test ', password: 'test-admin-password' }, 'test-ip');
        expect(user).toMatchObject({ id: 'tokko-system-admin', email: 'admin@example.test' });
        expect(JSON.stringify(user)).not.toContain(hash); expect(JSON.stringify(user)).not.toContain('test-admin-password');
        expect(await authenticateSystemAdmin({ email: 'other@example.test', password: 'test-admin-password' }, 'test-ip')).toBeNull();
        expect(await authenticateSystemAdmin({ email: 'admin@example.test', password: 'incorrect' }, 'test-ip')).toBeNull();
        expect(mocks.rate).toHaveBeenCalledWith('system-admin-ip:test-ip', 30, 900);
        expect(mocks.rate).toHaveBeenCalledWith('system-admin-login', 20, 900);
    });
    it.each(['', 'legacy-password', 'scrypt-v1$invalid'])('fails closed with missing or invalid hash %s', async stored => {
        vi.stubEnv('SYSTEM_ADMIN_PASSWORD_HASH', stored);
        expect(await authenticateSystemAdmin({ email: 'admin@example.test', password: 'test-admin-password' }, 'test-ip')).toBeNull();
        expect(await systemAdminSessionActive('any-version', Date.now())).toBe(false);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('does not skip rate limits for malformed credentials', async () => {
        expect(await authenticateSystemAdmin(undefined, 'test-ip')).toBeNull();
        expect(mocks.rate).toHaveBeenCalledTimes(2);
        mocks.rate.mockRejectedValueOnce(new Error('limited'));
        await expect(authenticateSystemAdmin({ email: 'admin@example.test', password: 'test-admin-password' }, 'test-ip')).rejects.toThrow('limited');
    });
    it('expires at eight hours and revokes existing sessions after configuration changes', async () => {
        const user = await authenticateSystemAdmin({ email: 'admin@example.test', password: 'test-admin-password' }, 'test-ip');
        const now = Date.now();
        expect(await systemAdminSessionActive(user!.adminCredentialVersion, now, now)).toBe(true);
        expect(await systemAdminSessionActive(user!.adminCredentialVersion, now - 8 * 60 * 60 * 1000, now)).toBe(false);
        expect(await systemAdminSessionActive(user!.adminCredentialVersion, now + 1, now)).toBe(false);
        expect(await systemAdminSessionActive(user!.adminCredentialVersion, NaN, now)).toBe(false);
        expect(await systemAdminSessionActive('wrong-version', now, now)).toBe(false);
        vi.stubEnv('SYSTEM_ADMIN_EMAIL', 'changed@example.test');
        expect(await systemAdminSessionActive(user!.adminCredentialVersion, now, now)).toBe(false);
        vi.stubEnv('SYSTEM_ADMIN_EMAIL', 'admin@example.test');
        vi.stubEnv('SYSTEM_ADMIN_PASSWORD_HASH', `scrypt-v1$${'a'.repeat(48)}$${'b'.repeat(128)}`);
        expect(await systemAdminSessionActive(user!.adminCredentialVersion, now, now)).toBe(false);
    });
    it('uses private database credentials when both hosting variables are absent', async () => {
        vi.stubEnv('SYSTEM_ADMIN_EMAIL', ''); vi.stubEnv('SYSTEM_ADMIN_PASSWORD_HASH', '');
        mocks.rpc.mockResolvedValue({ data: [{ email: 'admin@example.test', password_hash: hash, revision: 'first-revision' }], error: null });
        const user = await authenticateSystemAdmin({ email: 'admin@example.test', password: 'test-admin-password' }, 'test-ip');
        expect(user).toMatchObject({ email: 'admin@example.test' });
        expect(mocks.rpc).toHaveBeenCalledWith('tokko_system_admin_credentials');
        expect(await systemAdminSessionActive(user!.adminCredentialVersion, Date.now())).toBe(true);
        expect(JSON.stringify(user)).not.toContain(hash);
        mocks.rpc.mockResolvedValue({ data: [{ email: 'admin@example.test', password_hash: hash, revision: 'second-revision' }], error: null });
        expect(await systemAdminSessionActive(user!.adminCredentialVersion, Date.now())).toBe(false);
        mocks.rpc.mockResolvedValue({ data: [], error: null });
        expect(await systemAdminSessionActive(user!.adminCredentialVersion, Date.now())).toBe(false);
    });
    it('fails closed on disabled credentials or a database failure', async () => {
        vi.stubEnv('SYSTEM_ADMIN_EMAIL', ''); vi.stubEnv('SYSTEM_ADMIN_PASSWORD_HASH', '');
        expect(await authenticateSystemAdmin({ email: 'admin@example.test', password: 'test-admin-password' }, 'test-ip')).toBeNull();
        mocks.rpc.mockResolvedValue({ data: null, error: { code: '08000', message: 'private database detail' } });
        await expect(authenticateSystemAdmin({ email: 'admin@example.test', password: 'test-admin-password' }, 'test-ip')).rejects.toMatchObject({ status: 503 });
        await expect(systemAdminSessionActive('version', Date.now())).rejects.toMatchObject({ status: 503 });
    });
    it('never reads database credentials over an explicit environment configuration', async () => {
        expect(await systemAdminSessionActive('version', Date.now())).toBe(false);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
});
