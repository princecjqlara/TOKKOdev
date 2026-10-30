import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ facebook: vi.fn(), rpc: vi.fn() }));
vi.mock('../facebook', () => ({ getFacebookPages: mocks.facebook }));
vi.mock('../supabase', () => ({ getSupabaseAdmin: () => ({ rpc: mocks.rpc }) }));
import { recoverLegacyFacebookLogin } from '../facebook-login-recovery';
const identity = { subject: 'verified-subject', email: 'original@example.com', name: 'Original', image: null, accessToken: 'server-only-token' };
beforeEach(() => { vi.clearAllMocks(); });
describe('independent legacy Facebook account recovery', () => {
    it('passes only server-verified Facebook management IDs to the atomic recovery function', async () => {
        mocks.facebook.mockResolvedValue([{ id: 'managed', tasks: ['MANAGE'] }, { id: 'messaging-only', tasks: ['MESSAGING'] }]);
        mocks.rpc.mockResolvedValue({ data: [{ user_id: 'original-id', version: 0 }], error: null });
        expect(await recoverLegacyFacebookLogin(identity)).toEqual({ user_id: 'original-id', version: 0 });
        expect(mocks.facebook).toHaveBeenCalledWith('server-only-token');
        expect(mocks.rpc).toHaveBeenCalledWith('tokko_recover_legacy_facebook_login', expect.objectContaining({ p_subject: 'verified-subject', p_facebook_pages: ['managed'] }));
    });
    it('does not bind on email alone or when no management permission exists', async () => {
        expect(await recoverLegacyFacebookLogin({ ...identity, accessToken: undefined })).toBeNull();
        mocks.facebook.mockResolvedValue([{ id: 'page', tasks: ['MESSAGING'] }]);
        expect(await recoverLegacyFacebookLogin(identity)).toBeNull();
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('recovers a no-email legacy identity only through its authenticated subject-derived address', async () => {
        mocks.rpc.mockResolvedValue({ data: [{ user_id: 'no-email-original', version: 0 }], error: null });
        expect(await recoverLegacyFacebookLogin({ ...identity, email: null })).toEqual({ user_id: 'no-email-original', version: 0 });
        expect(mocks.facebook).not.toHaveBeenCalled();
        expect(mocks.rpc).toHaveBeenCalledWith('tokko_recover_legacy_facebook_login', expect.objectContaining({ p_email: 'fb_verified-subject@facebook.local', p_facebook_pages: [] }));
    });
    it('preserves a database denial and fails closed when verification is unavailable', async () => {
        mocks.facebook.mockResolvedValue([{ id: 'page', tasks: ['MANAGE'] }]);
        mocks.rpc.mockResolvedValue({ data: [], error: null });
        expect(await recoverLegacyFacebookLogin(identity)).toBeNull();
        mocks.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
        await expect(recoverLegacyFacebookLogin(identity)).rejects.toThrow('temporarily unavailable');
        mocks.facebook.mockRejectedValue(new Error('Facebook unavailable'));
        await expect(recoverLegacyFacebookLogin(identity)).rejects.toThrow();
    });
});
