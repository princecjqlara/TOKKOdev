import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ token: vi.fn(), active: vi.fn(), rate: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/server-auth-token', () => ({ getServerAuthToken: mocks.token }));
vi.mock('@/lib/account-auth', () => ({ getActiveAccount: mocks.active, takeAccountRateLimit: mocks.rate }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ rpc: mocks.rpc }) }));
import { GET, PUT } from './route';

const member = { id: 'member-id', name: 'Invited Name', phone_number: null, created_by: 'parent', account_kind: 'email', profile_required: true, profile_completed_at: null };
function request(body: unknown = { name: '  Ana María  ', phone: '0912 345 6789' }, origin = 'https://tokko.example') {
    return new NextRequest('https://tokko.example/api/account/profile', { method: 'PUT', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv('NEXTAUTH_URL', 'https://tokko.example');
    mocks.token.mockResolvedValue({ id: member.id, provider: 'credentials', sessionVersion: 2 });
    mocks.active.mockResolvedValue(member); mocks.rpc.mockResolvedValue({ data: true, error: null });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('subaccount first-login profile endpoint', () => {
    it('loads only the signed-in account details while operational access is gated', async () => {
        const response = await GET();
        expect(await response.json()).toEqual({ name: 'Invited Name', phone: '', requiresCompletion: true });
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(mocks.active).toHaveBeenCalledWith(member.id, 2, 'credentials');
    });
    it('saves normalized details against the signed-in ID and version, ignoring forged fields', async () => {
        const response = await PUT(request({ name: ' Ana María ', phone: '09123456789', userId: 'someone-else', profile_required: false }));
        expect(response.status).toBe(200);
        expect(mocks.rpc).toHaveBeenCalledWith('tokko_complete_subaccount_profile', { p_user: member.id, p_version: 2, p_name: 'Ana María', p_phone: '+639123456789' });
        expect(await response.json()).toEqual({ success: true });
    });
    it('denies a missing, expired or stale session before writing the profile', async () => {
        mocks.token.mockResolvedValue(null);
        expect((await GET()).status).toBe(401);
        mocks.token.mockResolvedValue({ id: member.id, provider: 'credentials', sessionVersion: 1 }); mocks.active.mockResolvedValue(null);
        expect((await PUT(request())).status).toBe(401);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it.each(['facebook', 'credentials'])('excludes original Facebook parents using %s from this step', async provider => {
        mocks.token.mockResolvedValue({ id: 'parent', provider, sessionVersion: 0 });
        mocks.active.mockResolvedValue({ id: 'parent', account_kind: 'facebook', profile_required: true });
        expect((await GET()).status).toBe(403);
        expect((await PUT(request())).status).toBe(403);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it.each([null, [], {}, { name: 'Ana', phone: 'bad' }].map(body => ({ body })))('rejects invalid data without a profile write: %j', async ({ body }) => {
        expect((await PUT(request(body))).status).toBe(400);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('blocks cross-origin writes and handles concurrent account changes', async () => {
        expect((await PUT(request({}, 'https://other.example'))).status).toBe(403);
        expect(mocks.rpc).not.toHaveBeenCalled();
        mocks.rpc.mockResolvedValue({ data: false, error: null });
        expect((await PUT(request())).status).toBe(409);
    });
});
