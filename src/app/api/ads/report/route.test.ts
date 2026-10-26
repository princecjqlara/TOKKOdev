import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ session: vi.fn(), accounts: vi.fn(), report: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: mocks.session }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/server-auth-token', () => ({ getFacebookServerToken: vi.fn().mockResolvedValue('own-token') }));
vi.mock('@/lib/meta-ads', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/meta-ads')>(), getMetaAdAccounts: mocks.accounts, getMetaAdsReport: mocks.report
}));
import { GET } from './route';

const request = (query = 'account=act_123&goal=messages') => new NextRequest(`http://localhost:3000/api/ads/report?${query}`);
beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue({ user: { id: 'user' }, accessToken: 'own-token' }); });

describe('GET /api/ads/report authorization', () => {
    it('rejects anonymous requests before fetching ad data', async () => {
        mocks.session.mockResolvedValue(null);
        expect((await GET(request())).status).toBe(401);
        expect(mocks.accounts).not.toHaveBeenCalled();
    });
    it('rejects invalid account IDs and result goals before calling Meta', async () => {
        expect((await GET(request('account=../../me&goal=messages'))).status).toBe(400);
        expect((await GET(request('account=act_123&goal=clicks'))).status).toBe(400);
        expect(mocks.accounts).not.toHaveBeenCalled();
    });
    it('rejects accounts outside the current Facebook user’s access', async () => {
        mocks.accounts.mockResolvedValue([{ id: 'act_456' }]);
        expect((await GET(request())).status).toBe(403);
        expect(mocks.report).not.toHaveBeenCalled();
    });
    it('uses the current user token and makes its response private and uncached', async () => {
        const account = { id: 'act_123' };
        mocks.accounts.mockResolvedValue([account]); mocks.report.mockResolvedValue({ ads: [] });
        const response = await GET(request());
        expect(response.status).toBe(200);
        expect(mocks.report).toHaveBeenCalledWith('own-token', account, 'messages');
        expect(response.headers.get('cache-control')).toBe('private, no-store');
    });
});
