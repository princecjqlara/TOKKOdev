import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { AccessError } from '@/lib/account-security';
const mocks = vi.hoisted(() => ({ session: vi.fn(), db: vi.fn(), manager: vi.fn(), pages: vi.fn(), ready: vi.fn(), rate: vi.fn(), mail: vi.fn(), mailConfig: vi.fn(), hash: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: mocks.session }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.db }));
vi.mock('@/lib/page-managers', () => ({ requireTeamPageAdministrator: mocks.manager, teamAdministrationPages: mocks.pages }));
vi.mock('@/lib/account-auth', () => ({ accountsReady: mocks.ready, takeAccountRateLimit: mocks.rate }));
vi.mock('@/lib/account-mail', () => ({ processAccountMail: mocks.mail, requireAccountMail: mocks.mailConfig, accountMailConfigured: () => true }));
vi.mock('@/lib/account-security', async original => ({ ...await original<typeof import('@/lib/account-security')>(), hashAccountPassword: mocks.hash }));
import { GET, POST, PATCH, DELETE } from './route';

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
    mocks.mailConfig.mockReset();
    mocks.hash.mockImplementation(async password => {
        if (typeof password !== 'string' || password.length < 12) throw new AccessError(400, 'Use at least 12 characters.');
        return 'scrypt-v1$server-generated-hash';
    });
});
afterEach(() => { vi.unstubAllEnvs(); });
describe('manager-only account and Page assignment endpoints', () => {
    it('supports multiple Pages, duplicate Page selections, and temporary deletion without a changing retry fingerprint', async () => {
        const secondPage='44444444-4444-4444-8444-444444444444';
        const rpc=vi.fn().mockResolvedValue({data:{passwordCreated:true,pending:false},error:null}); mocks.db.mockReturnValue({rpc});
        const body={name:'Team Member',email:'temporary@example.com',password:'A team password 123!',setupMethod:'password',pageIds:[page,secondPage,page],lifetimeDays:7,deleteAfterExpiry:true};
        expect((await POST(request('POST',body))).status).toBe(200);
        expect((await POST(request('POST',body))).status).toBe(200);
        expect(rpc).toHaveBeenCalledWith('tokko_save_subaccount',expect.objectContaining({p_pages:[page,secondPage],p_lifetime_days:7,p_delete_after_expiry:true}));
        expect(rpc.mock.calls[0][1].p_fingerprint).toBe(rpc.mock.calls[1][1].p_fingerprint);
    });
    it('lets the parent extend a temporary account or cancel scheduled deletion',async()=>{
        const rpc=vi.fn().mockResolvedValue({data:true,error:null});mocks.db.mockReturnValue({rpc});
        expect((await PATCH(request('PATCH',{userId:account,pageId:page,lifetimeDays:30,deleteAfterExpiry:true}))).status).toBe(200);
        expect(rpc).toHaveBeenCalledWith('tokko_set_subaccount_lifetime',expect.objectContaining({p_lifetime_days:30,p_delete_after_expiry:true}));
        expect((await PATCH(request('PATCH',{userId:account,pageId:page,expiresAt:null,deleteAfterExpiry:false}))).status).toBe(200);
        expect(rpc).toHaveBeenLastCalledWith('tokko_set_subaccount_lifetime',expect.objectContaining({p_expiry_set:true,p_expires_at:null,p_delete_after_expiry:false}));
    });
    it('creates a password account without requiring or sending email and keeps credentials out of its response', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: { passwordCreated: true, pending: false }, error: null }); mocks.db.mockReturnValue({ rpc });
        mocks.mailConfig.mockImplementation(() => { throw new AccessError(503, 'Mail unavailable'); });
        const response = await POST(request('POST', { name: 'Member', email: 'member@example.com', pageIds: [page], setupMethod: 'password', password: 'An initial password 123!' }));
        expect(response.status).toBe(200);
        expect(rpc).toHaveBeenCalledWith('tokko_save_subaccount', expect.objectContaining({ p_setup_method: 'password', p_password: 'scrypt-v1$server-generated-hash', p_expiry_set: false }));
        expect(rpc.mock.calls[0][1].p_encrypted).toBe('');
        expect(mocks.mailConfig).not.toHaveBeenCalled(); expect(mocks.mail).not.toHaveBeenCalled();
        expect(JSON.stringify(await response.json())).not.toMatch(/initial password 123|scrypt-v1|p_hash|p_password/);
    });
    it('uses a stable secret-keyed password fingerprint for retries and detects changed passwords', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: { passwordCreated: true, pending: false }, error: null }); mocks.db.mockReturnValue({ rpc });
        const body = { name: 'Member', email: 'member@example.com', pageIds: [page], setupMethod: 'password', password: 'An initial password 123!' };
        await POST(request('POST', body)); await POST(request('POST', body)); await POST(request('POST', { ...body, password: 'A different password 123!' }));
        expect(rpc.mock.calls[0][1].p_fingerprint).toBe(rpc.mock.calls[1][1].p_fingerprint);
        expect(rpc.mock.calls[0][1].p_fingerprint).not.toBe(rpc.mock.calls[2][1].p_fingerprint);
    });
    it('rejects overwriting existing credentials and rejects weak initial passwords', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: '42501' } }); mocks.db.mockReturnValue({ rpc });
        const body = { name: 'Member', email: 'member@example.com', pageIds: [page], setupMethod: 'password', password: 'An initial password 123!' };
        expect((await POST(request('POST', body))).status).toBe(403);
        rpc.mockClear();
        expect((await POST(request('POST', { ...body, password: 'short' }))).status).toBe(400);
        expect(rpc).not.toHaveBeenCalled();
    });
    it('assigns an existing account without mail or password changes and refuses unknown accounts', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: { pending: false }, error: null }); mocks.db.mockReturnValue({ rpc });
        const body = { name: 'Member', email: 'member@example.com', pageIds: [page], setupMethod: 'existing' };
        expect((await POST(request('POST', body))).status).toBe(200);
        expect(rpc).toHaveBeenCalledWith('tokko_save_subaccount', expect.objectContaining({ p_setup_method: 'existing', p_encrypted: '' }));
        expect(mocks.hash).not.toHaveBeenCalled(); expect(mocks.mailConfig).not.toHaveBeenCalled();
        rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'Existing active account required' } });
        expect((await POST(request('POST', body))).status).toBe(400);
    });
    it.each([null, { setupMethod: 'unknown' }, { setupMethod: 'email', password: 'An initial password 123!' }])('rejects invalid setup data without account side effects: %j', async body => {
        expect((await POST(request('POST', body))).status).toBe(400);
        expect(mocks.db).not.toHaveBeenCalled(); expect(mocks.hash).not.toHaveBeenCalled();
    });
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
        expect(rpc).toHaveBeenCalledWith('tokko_save_subaccount', expect.objectContaining({ p_setup_method: 'email', p_email: 'member@example.com', p_actor: 'manager', p_pages: [page], p_request: requestId, p_expiry_set: false, p_expires_at: null }));
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
    it('lists original Facebook Page assignments without requiring a new connection', async () => {
        mocks.db.mockReturnValue({}); mocks.pages.mockResolvedValue([{ id: page, name: 'Original Page', fb_page_id: 'fb-page', authoritySource: 'original' }]);
        const response = await GET(request('GET'));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ canManageAccounts: true, pages: [{ id: page, name: 'Original Page' }] });
    });
    it('saves optional expiry in the same provisioning transaction and fingerprint', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: { pending: false }, error: null }); mocks.db.mockReturnValue({ rpc });
        const expiresAt = new Date(Date.now() + 86400_000).toISOString();
        expect((await POST(request('POST', { name: 'Member', email: 'member@example.com', pageIds: [page], expiresAt }))).status).toBe(200);
        expect(rpc).toHaveBeenCalledWith('tokko_save_subaccount', expect.objectContaining({ p_expiry_set: true, p_expires_at: expiresAt }));
        const fingerprint = rpc.mock.calls[0][1].p_fingerprint;
        await POST(request('POST', { name: 'Member', email: 'member@example.com', pageIds: [page] }));
        expect(rpc.mock.calls[1][1].p_fingerprint).not.toBe(fingerprint);
    });
    it.each(['bad-date', '2020-01-01T00:00:00Z', '2099-01-01T12:00', 100])('rejects invalid or past expiry before provisioning: %s', async expiresAt => {
        expect((await POST(request('POST', { name: 'Member', email: 'member@example.com', pageIds: [page], expiresAt }))).status).toBe(400);
        expect(mocks.db).not.toHaveBeenCalled(); expect(mocks.manager).not.toHaveBeenCalled();
    });
    it('allows a creator to renew an account or remove its expiry', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: true, error: null }); mocks.db.mockReturnValue({ rpc });
        const expiresAt = new Date(Date.now() + 86400_000).toISOString();
        expect((await PATCH(request('PATCH', { userId: account, pageId: page, expiresAt }))).status).toBe(200);
        expect(rpc).toHaveBeenCalledWith('tokko_set_subaccount_lifetime', expect.objectContaining({ p_actor: 'manager', p_pages: [page], p_user: account, p_expires_at: expiresAt }));
        expect((await PATCH(request('PATCH', { userId: account, pageId: page, expiresAt: null }))).status).toBe(200);
        expect(rpc).toHaveBeenLastCalledWith('tokko_set_subaccount_lifetime', expect.objectContaining({ p_expires_at: null }));
    });
    it('denies expiry changes by another manager, email users, or a caller without Page authority', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: false, error: null }); mocks.db.mockReturnValue({ rpc });
        expect((await PATCH(request('PATCH', { userId: account, pageId: page, expiresAt: null }))).status).toBe(403);
        mocks.session.mockResolvedValue({ user: { id: account, provider: 'credentials' } }); rpc.mockClear();
        expect((await PATCH(request('PATCH', { userId: account, pageId: page, expiresAt: null }))).status).toBe(403);
        expect((await POST(request())).status).toBe(403);
        expect((await DELETE(request('DELETE', { userId: account, pageId: page }))).status).toBe(403);
        expect(rpc).not.toHaveBeenCalled();
        mocks.session.mockResolvedValue({ user: { id: 'manager', provider: 'facebook' } });
        mocks.manager.mockRejectedValue(new AccessError(403, 'No Page authority'));
        expect((await PATCH(request('PATCH', { userId: account, pageId: page, expiresAt: null }))).status).toBe(403);
        expect(rpc).not.toHaveBeenCalled();
    });
});
