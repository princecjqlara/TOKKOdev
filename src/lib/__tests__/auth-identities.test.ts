import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), previous: vi.fn(), active: vi.fn() }));
vi.mock('../supabase', () => ({ getSupabaseAdmin: () => ({ rpc: mocks.rpc }) }));
vi.mock('../server-auth-token', () => ({ getServerAuthToken: mocks.previous }));
vi.mock('../account-auth', () => ({ authenticateEmail: vi.fn(), getActiveAccount: mocks.active }));
import { authOptions } from '../auth';
const callback = () => ({ token: {}, user: { id: 'facebook-subject', email: 'existing@example.com', name: 'Existing' },
    account: { provider: 'facebook', providerAccountId: 'facebook-subject', access_token: 'secret-facebook-token' } });
beforeEach(() => { vi.clearAllMocks(); mocks.previous.mockResolvedValue(null); mocks.active.mockResolvedValue({ id: 'stable-user', created_by: null, account_kind: 'facebook' }); });
describe('provider identity binding and session redaction', () => {
    it('keeps the verified database ID rather than treating provider IDs as account IDs', async () => {
        mocks.rpc.mockResolvedValue({ data: [{ user_id: 'stable-user', version: 3 }], error: null });
        const token = await authOptions.callbacks!.jwt!(callback() as any);
        expect(token).toMatchObject({ id: 'stable-user', provider: 'facebook', facebookId: 'facebook-subject', sessionVersion: 3 });
        expect(mocks.rpc).toHaveBeenCalledWith('tokko_resolve_facebook_user', expect.objectContaining({ p_legacy_id: null }));
    });
    it('uses a previous legacy account ID only when the signed Facebook subject matches', async () => {
        mocks.previous.mockResolvedValue({ id: 'legacy-user', facebookId: 'another-facebook-subject' });
        mocks.rpc.mockResolvedValue({ data: [{ user_id: 'stable-user', version: 0 }], error: null });
        await authOptions.callbacks!.jwt!(callback() as any);
        expect(mocks.rpc).toHaveBeenCalledWith('tokko_resolve_facebook_user', expect.objectContaining({ p_legacy_id: null }));
        mocks.previous.mockResolvedValue({ id: 'legacy-user', facebookId: 'facebook-subject' });
        await authOptions.callbacks!.jwt!(callback() as any);
        expect(mocks.rpc).toHaveBeenLastCalledWith('tokko_resolve_facebook_user', expect.objectContaining({ p_legacy_id: 'legacy-user' }));
    });
    it('keeps blocked subaccounts out of Facebook login without inventing an account ID', async () => {
        mocks.rpc.mockResolvedValue({ data: null, error: { code: '28000', message: 'Subaccounts use email and password' } });
        const token = await authOptions.callbacks!.jwt!({ ...callback(), token: { id: 'unrelated-id' } } as any);
        expect(token.id).toBeUndefined(); expect(token.pendingFacebookLinkAt).toBeUndefined();
        expect(token.authenticationError).toBe('subaccount_credentials_required');
        expect(token.facebookId).toBe('facebook-subject');
    });
    it('does not expose provider credentials to client sessions', async () => {
        const session = await authOptions.callbacks!.session!({ session: { user: { name: 'Member' } },
            token: { id: 'stable-user', provider: 'facebook', facebookId: 'facebook-subject', sessionVersion: 3, accessToken: 'secret-facebook-token' } } as any);
        expect(session).toMatchObject({ user: { id: 'stable-user' }, accountType: 'parent' }); expect(JSON.stringify(session)).not.toContain('secret-facebook-token');
    });
    it('returns no operational identity for revoked or unactivated accounts', async () => {
        mocks.active.mockResolvedValue(null);
        const session = await authOptions.callbacks!.session!({ session: { user: { name: 'Member' } }, token: { id: 'member', provider: 'credentials', sessionVersion: 0 } } as any);
        expect(session).toMatchObject({ user: { id: undefined }, accountActive: false });
    });
    it('removes Facebook authority from an email sign-in even when an older cookie contained it', async () => {
        const token = await authOptions.callbacks!.jwt!({ token: { accessToken: 'old', facebookId: 'old-fb', pendingFacebookLinkAt: Date.now() },
            account: { provider: 'credentials' }, user: { id: 'member', sessionVersion: 2 } } as any);
        expect(token).toMatchObject({ id: 'member', provider: 'credentials', sessionVersion: 2 });
        expect(token.accessToken).toBeUndefined(); expect(token.facebookId).toBeUndefined(); expect(token.pendingFacebookLinkAt).toBeUndefined();
    });
    it('restores original app users in one identity call without Page permission or email verification redirects', async () => {
        mocks.rpc.mockResolvedValue({ data: [{ user_id: 'original-user', version: 0 }], error: null });
        const token = await authOptions.callbacks!.jwt!({ ...callback(), token: { pendingFacebookLinkAt: Date.now() } } as any);
        expect(mocks.rpc).toHaveBeenCalledTimes(1);
        expect(token).toMatchObject({ id: 'original-user', provider: 'facebook', sessionVersion: 0 });
        expect(token.pendingFacebookLinkAt).toBeUndefined();
    });
    it('does not turn inactive accounts or database failures into pending identity-link sessions', async () => {
        for (const error of [{ code: '28000', message: 'Account inactive' }, { code: '08000', message: 'Connection failed' }]) {
            mocks.rpc.mockResolvedValue({ data: null, error });
            await expect(authOptions.callbacks!.jwt!(callback() as any)).rejects.toThrow();
        }
    });
    it('restores legacy Facebook sign-ins where the provider does not supply an email', async () => {
        mocks.rpc.mockResolvedValue({ data: [{ user_id: 'no-email-original', version: 0 }], error: null });
        const token = await authOptions.callbacks!.jwt!({ ...callback(), user: { ...callback().user, email: null } } as any);
        expect(token.id).toBe('no-email-original'); expect(token.pendingFacebookLinkAt).toBeUndefined();
    });
    it('surfaces a service failure without switching a Facebook user to email login', async () => {
        mocks.active.mockRejectedValue(new Error('database unavailable'));
        const session = await authOptions.callbacks!.session!({ session: { user: { name: 'Member' } }, token: { id: 'member', provider: 'facebook', facebookId: 'fb' } } as any);
        expect(session).toMatchObject({ user: { id: undefined }, accountActive: false, signInProvider: 'facebook', authenticationError: 'service_unavailable' });
        expect(authOptions.pages?.error).toBe('/facebook-signin');
    });
    it('does not send stale pending Facebook sessions to email verification', async () => {
        const session = await authOptions.callbacks!.session!({ session: { user: {} }, token: { provider: 'facebook', facebookId: 'old-user', pendingFacebookLinkAt: Date.now() } } as any);
        expect(session).toMatchObject({ requiresFacebookVerification: false, signInProvider: 'facebook' });
    });
});
