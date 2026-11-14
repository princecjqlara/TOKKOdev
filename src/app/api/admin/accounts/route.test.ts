import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { AccessError } from '@/lib/account-security';
const mocks = vi.hoisted(() => ({ require: vi.fn(), db: vi.fn(), rate: vi.fn(), hash: vi.fn() }));
vi.mock('@/lib/require-system-admin', () => ({ requireSystemAdmin: mocks.require }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.db }));
vi.mock('@/lib/account-auth', () => ({ takeAccountRateLimit: mocks.rate }));
vi.mock('@/lib/account-security', async original => ({ ...await original<typeof import('@/lib/account-security')>(), hashAccountPassword: mocks.hash }));
import { GET } from './route';
import { POST } from './[userId]/password/route';
const userId = '22222222-2222-4222-8222-222222222222';
const context = { params: { userId } };
function reset(body: unknown = { password: 'new-test-password' }, origin = 'https://tokko.example') {
    return new NextRequest(`https://tokko.example/api/admin/accounts/${userId}/password`, { method: 'POST',
        headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv('NEXTAUTH_URL', 'https://tokko.example');
    mocks.require.mockResolvedValue({ user: { email: 'admin@example.test' } }); mocks.rate.mockResolvedValue(undefined);
    mocks.hash.mockImplementation(async password => { if (!password) throw new AccessError(400, 'Enter a password.'); return 'server-hash'; });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('private admin account endpoints', () => {
    it.each([401, 403])('denies unauthorized overview and password reset before database access (%s)', async status => {
        mocks.require.mockRejectedValue(new AccessError(status, 'Administrator access required.'));
        expect((await GET(new NextRequest('https://tokko.example/api/admin/accounts'))).status).toBe(status);
        expect((await POST(reset(), context)).status).toBe(status);
        expect(mocks.db).not.toHaveBeenCalled(); expect(mocks.hash).not.toHaveBeenCalled();
    });
    it('passes validated filters to a service-only overview and prevents caching', async () => {
        const data = { accounts: [], total: 0, summary: { accounts: 0 } };
        const rpc = vi.fn().mockResolvedValue({ data, error: null }); mocks.db.mockReturnValue({ rpc });
        const response = await GET(new NextRequest(`https://tokko.example/api/admin/accounts?search=Team&type=subaccount&lifetime=temporary&status=expired&page=2&parent=${userId}`));
        expect(response.status).toBe(200); expect(await response.json()).toEqual(data);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(rpc).toHaveBeenCalledWith('tokko_admin_accounts', { p_search: 'Team', p_type: 'subaccount', p_lifetime: 'temporary', p_status: 'expired', p_page: 2, p_page_size: 25, p_parent: userId });
    });
    it.each(['page=0', 'page=1.5', 'page=100001', 'type=admin', 'status=unknown', 'parent=bad-id', 'lifetime=forever', `search=${'a'.repeat(101)}`])('rejects invalid filters %s', async params => {
        expect((await GET(new NextRequest(`https://tokko.example/api/admin/accounts?${params}`))).status).toBe(400);
        expect(mocks.db).not.toHaveBeenCalled();
    });
    it('reports a missing migration without leaking database details', async () => {
        mocks.db.mockReturnValue({ rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'private SQL details' } }) });
        const response = await GET(new NextRequest('https://tokko.example/api/admin/accounts'));
        expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain('private SQL');
    });
    it('hashes a new password on the server and never returns credentials', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: true, error: null }); mocks.db.mockReturnValue({ rpc });
        const response = await POST(reset(), context);
        expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(rpc).toHaveBeenCalledWith('tokko_admin_reset_subaccount_password', { p_user: userId, p_password_hash: 'server-hash', p_admin_email: 'admin@example.test' });
        expect(JSON.stringify(await response.json())).not.toMatch(/new-test-password|server-hash/);
    });
    it('rejects cross-origin reset, invalid accounts, and empty passwords before writes', async () => {
        expect((await POST(reset(undefined, 'https://elsewhere.example'), context)).status).toBe(403);
        expect(mocks.require).not.toHaveBeenCalled();
        expect((await POST(reset(), { params: { userId: 'invalid' } })).status).toBe(400);
        expect((await POST(reset({ password: '' }), context)).status).toBe(400);
        expect(mocks.db).not.toHaveBeenCalled();
    });
    it('does not reset protected identities when the database denies the operation', async () => {
        mocks.db.mockReturnValue({ rpc: vi.fn().mockResolvedValue({ data: false, error: null }) });
        expect((await POST(reset(), context)).status).toBe(403);
    });
});
