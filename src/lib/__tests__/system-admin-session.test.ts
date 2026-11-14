import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ active: vi.fn(), adminActive: vi.fn(), authenticate: vi.fn(), session: vi.fn() }));
vi.mock('../supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../server-auth-token', () => ({ getServerAuthToken: vi.fn() }));
vi.mock('../account-auth', () => ({ getActiveAccount: mocks.active, authenticateEmail: vi.fn() }));
vi.mock('../system-admin-auth', () => ({ SYSTEM_ADMIN_PROVIDER: 'system-admin', authenticateSystemAdmin: mocks.authenticate, systemAdminSessionActive: mocks.adminActive }));
vi.mock('next-auth', () => ({ getServerSession: mocks.session }));
import { authOptions } from '../auth';
import { requireSystemAdmin } from '../require-system-admin';
import { getSessionFromRequest } from '../get-session';
import { NextRequest } from 'next/server';

beforeEach(() => {
    vi.clearAllMocks(); mocks.adminActive.mockReturnValue(true);
    mocks.active.mockResolvedValue({ id: 'parent', account_kind: 'facebook', created_by: null });
});

describe('administrator session boundaries', () => {
    it('discards workspace identity and provider secrets on administrator sign-in', async () => {
        const token = await authOptions.callbacks!.jwt!({ token: { id: 'parent', accessToken: 'facebook-token', facebookId: 'fb', sessionVersion: 2 },
            account: { provider: 'system-admin' }, user: { id: 'tokko-system-admin', email: 'admin@example.test', adminCredentialVersion: 'version' } } as any);
        expect(token).toMatchObject({ provider: 'system-admin', adminCredentialVersion: 'version' });
        expect(token.id).toBeUndefined(); expect(token.accessToken).toBeUndefined(); expect(token.facebookId).toBeUndefined();
        const session = await authOptions.callbacks!.session!({ session: { expires: 'later', user: { id: 'old' } }, token } as any);
        expect(session).toMatchObject({ isSystemAdmin: true, accountActive: true, user: { provider: 'system-admin' } });
        expect(session).not.toHaveProperty('user.id'); expect(mocks.active).not.toHaveBeenCalled();
        expect(JSON.stringify(session)).not.toMatch(/adminCredentialVersion|adminAuthenticatedAt|facebook-token/);
        mocks.session.mockResolvedValue(session);
        await expect(requireSystemAdmin()).resolves.toEqual(session);
        expect(await getSessionFromRequest(new NextRequest('https://tokko.example/api/pages'))).toBeNull();
    });
    it('does not elevate an ordinary account with the same email', async () => {
        const session = await authOptions.callbacks!.session!({ session: { isSystemAdmin: true, user: { email: 'admin@example.test' } },
            token: { id: 'parent', provider: 'facebook', adminCredentialVersion: 'version', adminAuthenticatedAt: Date.now() } } as any);
        expect(session).toMatchObject({ isSystemAdmin: false, user: { id: 'parent' } });
        mocks.session.mockResolvedValue(session);
        await expect(requireSystemAdmin()).rejects.toMatchObject({ status: 403 });
    });
    it('revokes admin access without falling back to a workspace account', async () => {
        mocks.adminActive.mockReturnValue(false);
        const session = await authOptions.callbacks!.session!({ session: { user: {} },
            token: { id: 'parent', provider: 'system-admin', adminCredentialVersion: 'old-version', adminAuthenticatedAt: 1 } } as any);
        expect(session).toMatchObject({ isSystemAdmin: false, accountActive: false });
        expect(session).not.toHaveProperty('user.id'); expect(mocks.active).not.toHaveBeenCalled();
        mocks.session.mockResolvedValue(session);
        await expect(requireSystemAdmin()).rejects.toMatchObject({ status: 403 });
    });
    it('removes admin markers when signing in with normal credentials', async () => {
        const token = await authOptions.callbacks!.jwt!({ token: { provider: 'system-admin', adminCredentialVersion: 'version', adminAuthenticatedAt: Date.now() },
            account: { provider: 'credentials' }, user: { id: 'member', sessionVersion: 2 } } as any);
        expect(token.provider).toBe('credentials'); expect(token.adminCredentialVersion).toBeUndefined(); expect(token.adminAuthenticatedAt).toBeUndefined();
    });
    it('denies access during an asynchronous administrator configuration outage', async () => {
        mocks.adminActive.mockRejectedValueOnce(new Error('private database details'));
        const session = await authOptions.callbacks!.session!({ session: { user: {} },
            token: { provider: 'system-admin', adminCredentialVersion: 'version', adminAuthenticatedAt: Date.now() } } as any);
        expect(session).toMatchObject({ isSystemAdmin: false, accountActive: false, authenticationError: 'service_unavailable' });
        expect(JSON.stringify(session)).not.toContain('private database details');
        mocks.session.mockResolvedValue(session);
        await expect(requireSystemAdmin()).rejects.toMatchObject({ status: 503 });
    });
    it('denies missing or mismatched admin sessions', async () => {
        mocks.session.mockResolvedValue(null);
        await expect(requireSystemAdmin()).rejects.toMatchObject({ status: 401 });
        mocks.session.mockResolvedValue({ isSystemAdmin: true, accountActive: true, user: { provider: 'credentials' } });
        await expect(requireSystemAdmin()).rejects.toMatchObject({ status: 403 });
    });
});
