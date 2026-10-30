import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from 'next-auth';
const mocks = vi.hoisted(() => ({ facebook: vi.fn(), token: vi.fn(), db: vi.fn() }));
vi.mock('../facebook', () => ({ getFacebookPages: mocks.facebook }));
vi.mock('../server-auth-token', () => ({ getFacebookServerToken: mocks.token }));
vi.mock('../supabase', () => ({ getSupabaseAdmin: mocks.db }));
import { hasFacebookManagementTask, requireFacebookPageManager, requireTeamPageAdministrator, teamAdministrationPages, verifiedFacebookPages } from '../page-managers';
const session = { user: { id: 'manager', provider: 'facebook', facebookId: 'fb-user' } } as Session;
function database(pageRows: { id: string; fb_page_id: string; grant_source?: string }[], parent = true) {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn((table: string) => {
        if (table === 'user_pages') return { select: () => ({ eq: () => {
            const result = { data: pageRows.map(page => ({ pages: page, grant_source: page.grant_source || 'legacy' })), error: null };
            return Object.assign(Promise.resolve(result), { in: async (_column: string, ids: string[]) => ({ ...result, data: result.data.filter(row => ids.includes(row.pages.id)) }) });
        } }) };
        if (table === 'tokko_page_managers') return { upsert };
        throw Error(`Unexpected ${table}`);
    });
    return { from, upsert, rpc: vi.fn().mockImplementation(async (name: string) => ({ data: name === 'tokko_is_parent_user' ? parent : [{ user_id: 'manager' }], error: null })) };
}
beforeEach(() => { vi.clearAllMocks(); mocks.token.mockResolvedValue('server-only-token'); mocks.facebook.mockResolvedValue([{ id: 'fb-a', tasks: ['MANAGE'] }]); });
describe('verified Facebook manager authority', () => {
    it('treats an unavailable identity service as temporary instead of asking an authorized parent to sign in again', async () => {
        const db = database([{ id: 'a', fb_page_id: 'fb-a' }]); mocks.db.mockReturnValue(db);
        db.rpc.mockResolvedValueOnce({ data: null, error: { code: '08000' } });
        await expect(requireTeamPageAdministrator(session, ['a'])).rejects.toMatchObject({ status: 503 });
        expect(db.upsert).not.toHaveBeenCalled(); expect(mocks.facebook).not.toHaveBeenCalled();
    });
    it('requires actual management tasks, not messaging tasks or a Facebook-shaped role', () => {
        expect(hasFacebookManagementTask({ tasks: ['MESSAGING', 'ADVERTISE'] })).toBe(false);
        expect(hasFacebookManagementTask({ tasks: ['MANAGE'] })).toBe(true);
    });
    it('denies email members before contacting Facebook or writing proofs', async () => {
        await expect(verifiedFacebookPages({ user: { id: 'member', provider: 'credentials' } } as Session)).rejects.toMatchObject({ status: 403 });
        expect(mocks.facebook).not.toHaveBeenCalled(); expect(mocks.db).not.toHaveBeenCalled();
    });
    it('verifies every selected Page before persisting any authority proof', async () => {
        const db = database([{ id: 'a', fb_page_id: 'fb-a' }, { id: 'b', fb_page_id: 'fb-b' }]); mocks.db.mockReturnValue(db);
        await expect(requireFacebookPageManager(session, ['a', 'b'])).rejects.toMatchObject({ status: 403 });
        expect(db.upsert).not.toHaveBeenCalled();
    });
    it('does not trust a stale manager flag when Meta cannot verify permissions', async () => {
        mocks.facebook.mockRejectedValue(new Error('rate limit'));
        await expect(requireFacebookPageManager(session, ['a'])).rejects.toMatchObject({ status: 503 });
        expect(mocks.db).not.toHaveBeenCalled();
    });
    it('records Page-specific server-verified authority for the authenticated identity', async () => {
        const db = database([{ id: 'a', fb_page_id: 'fb-a' }]); mocks.db.mockReturnValue(db);
        await requireFacebookPageManager(session, ['a']);
        expect(db.upsert).toHaveBeenCalledWith([expect.objectContaining({ user_id: 'manager', page_id: 'a', facebook_subject: 'fb-user' })], expect.anything());
    });
    it.each(['legacy', 'facebook', 'delegated'])('lets original Facebook app users administer their existing %s assignments', async grant_source => {
        const db = database([{ id: 'a', fb_page_id: 'fb-a', grant_source }]); mocks.db.mockReturnValue(db); mocks.token.mockResolvedValue(null);
        await requireTeamPageAdministrator(session, ['a']);
        expect(mocks.facebook).not.toHaveBeenCalled();
        expect(db.upsert).toHaveBeenCalledWith([expect.objectContaining({ page_id: 'a', authority_source: 'original' })], expect.anything());
    });
    it('never promotes a team-created subaccount through a Facebook login', async () => {
        const db = database([{ id: 'a', fb_page_id: 'fb-a', grant_source: 'delegated' }], false); mocks.db.mockReturnValue(db);
        mocks.facebook.mockResolvedValue([{ id: 'fb-a', tasks: ['MESSAGING'] }]);
        await expect(teamAdministrationPages(session)).rejects.toMatchObject({ status: 403 });
        await expect(requireTeamPageAdministrator(session, ['a'])).rejects.toMatchObject({ status: 403 });
        expect(db.upsert).not.toHaveBeenCalled();
    });
    it('does not require Meta MANAGE permission to use a Tokko Page already assigned to a parent', async () => {
        const db = database([{ id: 'a', fb_page_id: 'fb-a', grant_source: 'delegated' }]); mocks.db.mockReturnValue(db);
        await requireTeamPageAdministrator(session, ['a']);
        expect(db.upsert).toHaveBeenCalledWith([expect.objectContaining({ authority_source: 'original' })], expect.anything());
        expect(mocks.facebook).not.toHaveBeenCalled();
    });
    it('rejects email sessions, mismatched identities and unassigned Pages', async () => {
        const db = database([{ id: 'a', fb_page_id: 'fb-a' }]); mocks.db.mockReturnValue(db);
        await expect(teamAdministrationPages({ user: { id: 'member', provider: 'credentials' } } as Session)).rejects.toMatchObject({ status: 403 });
        db.rpc.mockResolvedValueOnce({ data: [{ user_id: 'another-user' }], error: null });
        await expect(requireTeamPageAdministrator(session, ['a'])).rejects.toMatchObject({ status: 403 });
        await expect(requireTeamPageAdministrator(session, ['foreign'])).rejects.toMatchObject({ status: 403 });
        expect(db.upsert).not.toHaveBeenCalled();
    });
});
