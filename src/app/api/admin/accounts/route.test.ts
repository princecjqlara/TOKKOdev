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
import { PATCH, DELETE } from './[userId]/route';
const userId = '22222222-2222-4222-8222-222222222222';
const context = { params: { userId } };
function reset(body: unknown = { password: 'new-test-password' }, origin = 'https://tokko.example') {
    return new NextRequest(`https://tokko.example/api/admin/accounts/${userId}/password`, { method: 'POST',
        headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function manage(method: 'PATCH' | 'DELETE', body: unknown, origin = 'https://tokko.example') {
    return new NextRequest(`https://tokko.example/api/admin/accounts/${userId}`, { method,
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
        expect((await PATCH(manage('PATCH', { action: 'status', active: false }), context)).status).toBe(status);
        expect((await DELETE(manage('DELETE', { confirmation: 'member@example.test' }), context)).status).toBe(status);
        expect(mocks.db).not.toHaveBeenCalled(); expect(mocks.hash).not.toHaveBeenCalled();
    });
    it('passes validated filters to a service-only overview and prevents caching', async () => {
        const data = { accounts: [], total: 0, summary: { accounts: 0 } };
        const rpc = vi.fn().mockResolvedValue({ data, error: null }); mocks.db.mockReturnValue({ rpc });
        const response = await GET(new NextRequest(`https://tokko.example/api/admin/accounts?search=Team&type=subaccount&lifetime=temporary&status=expired&page=2&parent=${userId}`));
        expect(response.status).toBe(200); expect(await response.json()).toEqual(data);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(rpc).toHaveBeenCalledWith('tokko_admin_accounts_v2', { p_search: 'Team', p_type: 'subaccount', p_lifetime: 'temporary', p_status: 'expired', p_page: 2, p_page_size: 25, p_parent: userId,
            p_page_id: null, p_assignment: 'all', p_expires_within: null, p_deletion: 'all', p_password: 'all', p_sort: 'newest' });
    });
    it.each(['page=0', 'page=1.5', 'page=100001', 'type=admin', 'status=unknown', 'parent=bad-id', 'lifetime=forever', `search=${'a'.repeat(101)}`,
        'pageId=bad-id', 'assignment=invalid', 'expiresWithin=0', 'expiresWithin=14', 'expiresWithin=NaN', 'deletion=yes', 'password=plaintext', 'sort=arbitrary'])('rejects invalid filters %s', async params => {
        expect((await GET(new NextRequest(`https://tokko.example/api/admin/accounts?${params}`))).status).toBe(400);
        expect(mocks.db).not.toHaveBeenCalled();
    });
    it('passes all extra filters to the database before pagination', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: { accounts: [], total: 0 }, error: null }); mocks.db.mockReturnValue({ rpc });
        const response = await GET(new NextRequest(`https://tokko.example/api/admin/accounts?pageId=${userId}&assignment=assigned&expiresWithin=7&deletion=scheduled&password=set&sort=expiry`));
        expect(response.status).toBe(200);
        expect(rpc).toHaveBeenCalledWith('tokko_admin_accounts_v2', expect.objectContaining({ p_page_id: userId, p_assignment: 'assigned', p_expires_within: 7, p_deletion: 'scheduled', p_password: 'set', p_sort: 'expiry' }));
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
    it('requires same-origin management and explicit delete confirmation before writes', async () => {
        expect((await DELETE(manage('DELETE', { confirmation: 'member@example.test' }, 'https://elsewhere.example'), context)).status).toBe(403);
        expect((await PATCH(manage('PATCH', { action: 'status', active: false }, 'https://elsewhere.example'), context)).status).toBe(403);
        expect(mocks.require).not.toHaveBeenCalled();
        expect((await DELETE(manage('DELETE', { confirmation: '' }), context)).status).toBe(400);
        expect((await DELETE(manage('DELETE', {}), context)).status).toBe(400);
        expect((await DELETE(manage('DELETE', { confirmation: 'member@example.test' }), { params: { userId: 'bad' } })).status).toBe(400);
        expect(mocks.db).not.toHaveBeenCalled();
    });
    it('sends deletion through the audited database function and reports preservation', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: true, error: null }); mocks.db.mockReturnValue({ rpc });
        const response = await DELETE(manage('DELETE', { confirmation: ' member@example.test ' }), context);
        expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(rpc).toHaveBeenCalledWith('tokko_admin_delete_account', { p_user: userId, p_confirmation: 'member@example.test', p_admin_email: 'admin@example.test' });
        expect((await response.json()).message).toContain('Shared Pages');
    });
    it.each([['22023', 400], ['23503', 409]])('reports rejected deletion %s without leaking database details', async (code, status) => {
        mocks.db.mockReturnValue({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code, message: 'private database details' } }) });
        const response = await DELETE(manage('DELETE', { confirmation: 'member@example.test' }), context);
        expect(response.status).toBe(status); expect(JSON.stringify(await response.json())).not.toContain('private database details');
    });
    it.each([true, false])('allows the administrator to set active=%s', async active => {
        const rpc = vi.fn().mockResolvedValue({ data: true, error: null }); mocks.db.mockReturnValue({ rpc });
        expect((await PATCH(manage('PATCH', { action: 'status', active }), context)).status).toBe(200);
        expect(rpc).toHaveBeenCalledWith('tokko_admin_set_account_active', { p_user: userId, p_active: active, p_admin_email: 'admin@example.test' });
    });
    it('supports permanent access, day-based renewal, and canceling scheduled deletion', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: true, error: null }); mocks.db.mockReturnValue({ rpc });
        expect((await PATCH(manage('PATCH', { action: 'lifetime', expiresAt: null, deleteAfterExpiry: false }), context)).status).toBe(200);
        expect(rpc).toHaveBeenLastCalledWith('tokko_admin_set_account_lifetime', expect.objectContaining({ p_expiry_set: true, p_expires_at: null, p_lifetime_days: null, p_delete_after_expiry: false }));
        expect((await PATCH(manage('PATCH', { action: 'lifetime', lifetimeDays: 30, deleteAfterExpiry: true }), context)).status).toBe(200);
        expect(rpc).toHaveBeenLastCalledWith('tokko_admin_set_account_lifetime', expect.objectContaining({ p_expiry_set: false, p_lifetime_days: 30, p_delete_after_expiry: true }));
        expect((await PATCH(manage('PATCH', { action: 'lifetime', deleteAfterExpiry: false }), context)).status).toBe(200);
    });
    it.each([null, [], { action: 'unknown' }, { action: 'status', active: 'false' }, { action: 'lifetime' }, { action: 'lifetime', lifetimeDays: -1 }, { action: 'lifetime', lifetimeDays: 2.5 }])('rejects invalid management details before writes: %j', async body => {
        expect((await PATCH(manage('PATCH', body), context)).status).toBe(400); expect(mocks.db).not.toHaveBeenCalled();
    });
    it('reports protected and missing accounts for both management endpoints', async () => {
        mocks.db.mockReturnValue({ rpc: vi.fn().mockResolvedValue({ data: false, error: null }) });
        expect((await PATCH(manage('PATCH', { action: 'status', active: false }), context)).status).toBe(404);
        expect((await DELETE(manage('DELETE', { confirmation: 'member@example.test' }), context)).status).toBe(404);
    });
});
