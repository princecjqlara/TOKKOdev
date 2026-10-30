import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ session: vi.fn(), token: vi.fn(), db: vi.fn(), ready: vi.fn(), rate: vi.fn(), hash: vi.fn(), verify: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: mocks.session }));
vi.mock('@/lib/server-auth-token', () => ({ getServerAuthToken: mocks.token }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.db }));
vi.mock('@/lib/account-auth', () => ({ accountsReady: mocks.ready, takeAccountRateLimit: mocks.rate }));
vi.mock('@/lib/account-security', async original => ({ ...await original<typeof import('@/lib/account-security')>(), hashAccountPassword: mocks.hash, verifyAccountPassword: mocks.verify }));
import { GET, PUT } from './route';
const user = { id: 'own-id', email: 'original@example.com', facebook_id: 'verified-fb', session_version: 3, password_hash: null, email_login_enabled: false, email_verified_at: null };
function database(account: object = user) {
    const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: account, error: null }) }));
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    return { from: () => ({ select: () => ({ eq }) }), rpc, eq };
}
function request(body: unknown = { password: 'A new secure password 123!' }, origin = 'https://tokko.example') {
    return new NextRequest('https://tokko.example/api/account/sign-in-password', { method: 'PUT', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv('NEXTAUTH_URL', 'https://tokko.example');
    mocks.session.mockResolvedValue({ user: { id: 'own-id', provider: 'facebook', facebookId: 'verified-fb' } });
    mocks.token.mockResolvedValue({ id: 'own-id', provider: 'facebook', facebookId: 'verified-fb', sessionVersion: 3 });
    mocks.ready.mockResolvedValue(true); mocks.hash.mockResolvedValue('scrypt-v1$new-server-hash'); mocks.verify.mockResolvedValue(true);
    mocks.db.mockReturnValue(database());
});
afterEach(() => { vi.unstubAllEnvs(); });
describe('setting or changing your own sign-in password', () => {
    it('changes only the signed-in subaccount password, ignoring a forged target ID', async () => {
        const db = database({ ...user, password_hash: 'old-private-hash', email_login_enabled: true, email_verified_at: '2026-10-30T00:00:00Z' }); mocks.db.mockReturnValue(db);
        const response = await PUT(request({ password: 'A new secure password 123!', currentPassword: 'old password', userId: 'forged-target' }));
        expect(response.status).toBe(200);
        expect(db.eq).toHaveBeenCalledWith('id', 'own-id');
        expect(db.rpc).toHaveBeenCalledWith('tokko_set_own_password', { p_user: 'own-id', p_subject: null, p_version: 3, p_expected_password: 'old-private-hash', p_password: 'scrypt-v1$new-server-hash' });
        expect(await response.json()).toMatchObject({ requiresSignIn: true });
    });
    it('returns password availability without exposing stored hashes or tokens', async () => {
        mocks.db.mockReturnValue(database({ ...user, password_hash: 'stored-private-hash', email_login_enabled: true }));
        const response = await GET(request()); const data = await response.json();
        expect(data).toMatchObject({ hasPassword: true, canSetPassword: true, email: user.email });
        expect(JSON.stringify(data)).not.toMatch(/stored-private|password_hash|session_version|verified-fb/);
    });
    it('requires the existing password and protects against a concurrent account reset', async () => {
        const db = database({ ...user, password_hash: 'stored-private-hash', email_login_enabled: true, email_verified_at: '2026-10-30T00:00:00Z' }); mocks.db.mockReturnValue(db);
        mocks.verify.mockResolvedValue(false);
        expect((await PUT(request({ password: 'new-password-here', currentPassword: 'wrong' }))).status).toBe(400);
        expect(db.rpc).not.toHaveBeenCalled(); expect(mocks.hash).not.toHaveBeenCalled();
        mocks.verify.mockResolvedValue(true); db.rpc.mockResolvedValue({ data: false, error: null });
        expect((await PUT(request({ password: 'new-password-here', currentPassword: 'correct' }))).status).toBe(409);
        expect(db.rpc).toHaveBeenCalledWith('tokko_set_own_password', expect.objectContaining({ p_expected_password: 'stored-private-hash' }));
    });
    it('does not let an email session or another Facebook identity set a first password', async () => {
        const db = database(); mocks.db.mockReturnValue(db);
        mocks.session.mockResolvedValue({ user: { id: 'own-id', provider: 'credentials' } });
        expect((await PUT(request())).status).toBe(403);
        mocks.session.mockResolvedValue({ user: { id: 'own-id', provider: 'facebook', facebookId: 'different-fb' } });
        expect((await PUT(request())).status).toBe(403);
        expect(db.rpc).not.toHaveBeenCalled();
    });
    it('denies unauthenticated, stale and foreign-origin writes', async () => {
        const db = database(); mocks.db.mockReturnValue(db);
        expect((await PUT(request({}, 'https://evil.test'))).status).toBe(403);
        mocks.session.mockResolvedValue(null);
        expect((await PUT(request())).status).toBe(401);
        mocks.session.mockResolvedValue({ user: { id: 'own-id', provider: 'facebook', facebookId: 'verified-fb' } });
        mocks.token.mockResolvedValue({ id: 'own-id', sessionVersion: 2 });
        expect((await PUT(request())).status).toBe(401);
        expect(db.rpc).not.toHaveBeenCalled();
    });
    it('does not enable passwords before isolation or for a synthetic Facebook email', async () => {
        mocks.ready.mockResolvedValue(false);
        expect((await PUT(request())).status).toBe(503);
        mocks.ready.mockResolvedValue(true); mocks.db.mockReturnValue(database({ ...user, email: 'fb_123@facebook.local' }));
        expect((await PUT(request())).status).toBe(400);
        expect(mocks.hash).not.toHaveBeenCalled();
    });
});
