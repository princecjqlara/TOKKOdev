import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ token: vi.fn(), db: vi.fn(), ready: vi.fn(), rate: vi.fn(), mail: vi.fn() }));
vi.mock('@/lib/server-auth-token', () => ({ getServerAuthToken: mocks.token }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.db }));
vi.mock('@/lib/account-auth', () => ({ accountsReady: mocks.ready, takeAccountRateLimit: mocks.rate }));
vi.mock('@/lib/account-mail', () => ({ requireAccountMail: mocks.mail }));
import { POST, PUT } from './route';
function request(method: string, body: unknown) { return new NextRequest('https://tokko.example/api/account/facebook-link', {
    method, headers: { origin: 'https://tokko.example', 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}); }
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('NEXTAUTH_URL', 'https://tokko.example'); vi.stubEnv('NEXTAUTH_SECRET', 'test-secret');
    mocks.ready.mockResolvedValue(true); mocks.token.mockResolvedValue({ provider: 'facebook', facebookId: 'verified-subject', pendingFacebookLinkAt: Date.now() }); });
afterEach(() => { vi.unstubAllEnvs(); });
describe('explicit Facebook identity confirmation', () => {
    it.each([null, { provider: 'credentials', id: 'member' }, { provider: 'facebook', id: 'active-user', facebookId: 'verified-subject', pendingFacebookLinkAt: Date.now() },
        { provider: 'facebook', facebookId: 'verified-subject', pendingFacebookLinkAt: Date.now() - 16 * 60 * 1000 }])('denies missing, active, or expired pending identity: %j', async token => {
        mocks.token.mockResolvedValue(token);
        expect((await POST(request('POST', { email: 'existing@example.com' }))).status).toBe(403);
        expect(mocks.db).not.toHaveBeenCalled();
    });
    it('binds requests to the server-side Facebook subject and does not disclose account existence', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: null, error: null }); mocks.db.mockReturnValue({ rpc });
        const response = await POST(request('POST', { email: 'Existing@Example.com', subject: 'forged' }));
        expect(response.status).toBe(202);
        expect(rpc).toHaveBeenCalledWith('tokko_queue_facebook_link', expect.objectContaining({ p_subject: 'verified-subject', p_email: 'existing@example.com' }));
        expect(JSON.stringify(await response.json())).not.toMatch(/token|encrypted|userId/);
    });
    it('confirms a single-use token only for the pending Facebook identity', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: true, error: null }); mocks.db.mockReturnValue({ rpc });
        const response = await PUT(request('PUT', { token: 'A'.repeat(43), subject: 'forged' }));
        expect(response.status).toBe(200);
        expect(rpc).toHaveBeenCalledWith('tokko_confirm_facebook_link', expect.objectContaining({ p_subject: 'verified-subject' }));
    });
    it('does not accept a valid-shaped token rejected by the database', async () => {
        mocks.db.mockReturnValue({ rpc: vi.fn().mockResolvedValue({ data: false, error: null }) });
        expect((await PUT(request('PUT', { token: 'A'.repeat(43) }))).status).toBe(400);
    });
});
