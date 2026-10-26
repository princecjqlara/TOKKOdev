import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ db: vi.fn(), compare: vi.fn() }));
vi.mock('../supabase', () => ({ getSupabaseAdmin: mocks.db }));
vi.mock('../account-security', async original => ({ ...await original<typeof import('../account-security')>(), verifyAccountPassword: mocks.compare }));
import { authenticateEmail, getActiveAccount } from '../account-auth';
const user = { id: 'member', name: 'Member', email: 'member@example.com', image: null, password_hash: 'stored-hash', is_active: true,
    email_login_enabled: true, email_verified_at: '2026-10-26T00:00:00Z', session_version: 2 };
function database(record: unknown = user, ready = true) {
    const rpc = vi.fn(async (name: string) => ({ data: name === 'tokko_accounts_ready' ? ready : name === 'tokko_take_auth_limit' ? true : record ? [record] : [], error: null }));
    return { rpc, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: record, error: null }) }) }) }) };
}
beforeEach(() => { vi.clearAllMocks(); mocks.compare.mockResolvedValue(true); });
describe('email account identity and live session validation', () => {
    it('authenticates an activated member without Facebook credentials or password data in its return value', async () => {
        const db = database(); mocks.db.mockReturnValue(db);
        const result = await authenticateEmail({ email: ' Member@Example.com ', password: 'entered-password' }, 'test-ip');
        expect(result).toEqual({ id: 'member', name: 'Member', email: 'member@example.com', image: null, sessionVersion: 2 });
        expect(db.rpc).toHaveBeenCalledWith('tokko_email_login_record', { p_email: 'member@example.com' });
    });
    it.each([null, { ...user, is_active: false }, { ...user, email_verified_at: null }, { ...user, email_login_enabled: false }])('rejects missing, inactive or unverified credentials: %j', async record => {
        mocks.db.mockReturnValue(database(record));
        expect(await authenticateEmail({ email: 'member@example.com', password: 'test-password' })).toBeNull();
        expect(mocks.compare).toHaveBeenCalledTimes(1);
    });
    it('disables email login before database finalization', async () => {
        mocks.db.mockReturnValue(database(user, false));
        expect(await authenticateEmail({ email: 'member@example.com', password: 'test-password' })).toBeNull();
        expect(mocks.compare).not.toHaveBeenCalled();
    });
    it('invalidates already signed-in sessions after password reset or account deactivation', async () => {
        mocks.db.mockReturnValue(database());
        expect(await getActiveAccount('member', 1, 'credentials')).toBeNull();
        expect(await getActiveAccount('member', 2, 'credentials')).toBeTruthy();
        mocks.db.mockReturnValue(database({ ...user, is_active: false }));
        expect(await getActiveAccount('member', 2, 'facebook')).toBeNull();
    });
});
