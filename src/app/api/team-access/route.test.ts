import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { AccessError } from '@/lib/account-security';
const mocks = vi.hoisted(() => ({ session: vi.fn(), db: vi.fn(), manager: vi.fn(), ready: vi.fn(), rate: vi.fn(), mail: vi.fn(), mailConfig: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: mocks.session }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.db }));
vi.mock('@/lib/page-managers', () => ({ requireFacebookPageManager: mocks.manager, verifiedFacebookPages: vi.fn() }));
vi.mock('@/lib/account-auth', () => ({ accountsReady: mocks.ready, takeAccountRateLimit: mocks.rate }));
vi.mock('@/lib/account-mail', () => ({ processAccountMail: mocks.mail, requireAccountMail: mocks.mailConfig, accountMailConfigured: () => true }));
import { GET, POST, DELETE } from './route';

const page = '11111111-1111-4111-8111-111111111111';
const account = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
function request(method = 'POST', body: unknown = { name: 'New Member', email: ' MEMBER@Example.com ', pageIds: [page] }) {
    return new NextRequest('https://tokko.example/api/team-access', { method,
        headers: { origin: 'https://tokko.example', 'Content-Type': 'application/json', 'Idempotency-Key': requestId },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv('NEXTAUTH_URL', 'https://tokko.example'); vi.stubEnv('NEXTAUTH_SECRET', 'test-secret-only');
    mocks.session.mockResolvedValue({ user: { id: 'manager', provider: 'facebook', facebookId: 'verified-fb' } });
    mocks.manager.mockResolvedValue([]); mocks.ready.mockResolvedValue(true); mocks.mail.mockResolvedValue(true);
});
afterEach(() => { vi.unstubAllEnvs(); });
describe('manager-only account and Page assignment endpoints', () => {
    it('rejects unauthenticated provisioning before accessing the database', async () => {
        mocks.session.mockResolvedValue(null);
        expect((await POST(request())).status).toBe(401); expect(mocks.db).not.toHaveBeenCalled();
    });
    it('does not create accounts or invitations when any manager check fails', async () => {
        mocks.manager.mockRejectedValue(new AccessError(403, 'Facebook manager required'));
        expect((await POST(request())).status).toBe(403);
        expect(mocks.db).not.toHaveBeenCalled(); expect(mocks.mail).not.toHaveBeenCalled();
    });
    it('uses one atomic provisioning RPC and returns no token or password material', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: { userId: account, pending: true, deliveryId: 'mail-id' }, error: null }); mocks.db.mockReturnValue({ rpc });
        const response = await POST(request()); const body = await response.json();
        expect(response.status).toBe(200); expect(body.pending).toBe(true);
        expect(rpc).toHaveBeenCalledWith('tokko_provision_member', expect.objectContaining({ p_email: 'member@example.com', p_actor: 'manager', p_pages: [page], p_request: requestId }));
        expect(JSON.stringify(body)).not.toMatch(/token|password_hash|encrypted|mail-id/);
        expect(mocks.mail).toHaveBeenCalledWith('mail-id');
    });
    it('preserves the saved account when invitation delivery needs retry', async () => {
        mocks.db.mockReturnValue({ rpc: vi.fn().mockResolvedValue({ data: { pending: true, deliveryId: 'mail-id' }, error: null }) });
        mocks.mail.mockResolvedValue(false);
        const response = await POST(request()); expect(response.status).toBe(200);
        expect((await response.json()).message).toContain('queued for retry');
    });
    it('prevents provisioning before database isolation is finalized or email is configured', async () => {
        mocks.ready.mockResolvedValue(false);
        expect((await POST(request())).status).toBe(503); expect(mocks.db).not.toHaveBeenCalled();
        mocks.ready.mockResolvedValue(true); mocks.mailConfig.mockImplementationOnce(() => { throw new AccessError(503, 'Sender missing'); });
        expect((await POST(request())).status).toBe(503); expect(mocks.db).not.toHaveBeenCalled();
    });
    it('does not let an email member enumerate the account directory', async () => {
        mocks.session.mockResolvedValue({ user: { id: account, provider: 'credentials' } });
        const response = await GET(request('GET'));
        expect(await response.json()).toEqual({ canManageAccounts: false, pages: [] }); expect(mocks.db).not.toHaveBeenCalled();
    });
    it('revokes only the requested Page through the manager-guarded RPC', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: true, error: null }); mocks.db.mockReturnValue({ rpc });
        expect((await DELETE(request('DELETE', { userId: account, pageId: page }))).status).toBe(200);
        expect(mocks.manager).toHaveBeenCalledWith(expect.anything(), [page]);
        expect(rpc).toHaveBeenCalledWith('tokko_revoke_member', { p_actor: 'manager', p_page: page, p_user: account });
    });
    it('rejects foreign origins and malformed Page selections without side effects', async () => {
        const foreign = new NextRequest('https://tokko.example/api/team-access', { method: 'POST', headers: { origin: 'https://other.example' } });
        expect((await POST(foreign)).status).toBe(403);
        expect((await POST(request('POST', { name: 'Member', email: 'member@example.com', pageIds: ['not-a-page'] }))).status).toBe(400);
        expect(mocks.manager).not.toHaveBeenCalled(); expect(mocks.db).not.toHaveBeenCalled();
    });
});
