import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from 'next-auth';
const mocks = vi.hoisted(() => ({ facebook: vi.fn(), token: vi.fn(), db: vi.fn() }));
vi.mock('../facebook', () => ({ getFacebookPages: mocks.facebook,
    isFacebookReauthRequired: (error: { requiresReauth?: boolean }) => error?.requiresReauth === true }));
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
        expect(hasFacebookManagementTask({ tasks: ['PROFILE_PLUS_MANAGE'] })).toBe(true);
        expect(hasFacebookManagementTask({ tasks: ['PROFILE_PLUS_FULL_CONTROL'] })).toBe(true);
        expect(hasFacebookManagementTask({ tasks: ['PROFILE_PLUS_MESSAGING', 'PROFILE_PLUS_FACEBOOK_ACCESS'] })).toBe(false);
    });

    it.each(['PROFILE_PLUS_MANAGE', 'PROFILE_PLUS_FULL_CONTROL'])('recognizes the current Facebook management task %s', async task => {
        const db = database([{ id: 'a', fb_page_id: 'fb-a' }]); mocks.db.mockReturnValue(db);
        mocks.facebook.mockResolvedValue([{ id: 'fb-a', tasks: [task] }]);
        await requireFacebookPageManager(session, ['a']);
        expect(db.upsert).toHaveBeenCalledWith([expect.objectContaining({ page_id: 'a', authority_source: 'facebook' })], expect.anything());
    });

    it('does not promote messaging-only task access into connection administration', async () => {
        const db = database([{ id: 'a', fb_page_id: 'fb-a' }]); mocks.db.mockReturnValue(db);
        mocks.facebook.mockResolvedValue([{ id: 'fb-a', tasks: ['PROFILE_PLUS_MESSAGING'] }]);
        await expect(requireFacebookPageManager(session, ['a'])).rejects.toMatchObject({ status: 403 });
        expect(db.upsert).not.toHaveBeenCalled();
    });

    it('accepts verified messaging access only when Page use is requested', async () => {
        mocks.db.mockReturnValue(database([]));
        mocks.facebook.mockResolvedValue([{ id: 'fb-a', tasks: ['PROFILE_PLUS_MESSAGING'] },
            { id: 'analytics-only', tasks: ['ANALYZE'] }, { id: 'manager', tasks: ['MANAGE'] }]);
        expect((await verifiedFacebookPages(session, 'messaging')).map(page => page.id)).toEqual(['fb-a', 'manager']);
        expect((await verifiedFacebookPages(session)).map(page => page.id)).toEqual(['manager']);
    });

    it('includes every connected Page in a verified parent account, including messaging connections', async () => {
        const db = database([{ id: 'a', fb_page_id: 'fb-a', grant_source: 'facebook_messaging' },
            { id: 'b', fb_page_id: 'fb-b', grant_source: 'facebook' }]); mocks.db.mockReturnValue(db);
        expect((await teamAdministrationPages(session)).map(page => page.id)).toEqual(['a', 'b']);
        await requireTeamPageAdministrator(session, ['a', 'b']);
        expect(db.upsert).toHaveBeenCalledWith([
            expect.objectContaining({ user_id: 'manager', page_id: 'a', authority_source: 'original' }),
            expect.objectContaining({ user_id: 'manager', page_id: 'b', authority_source: 'original' })
        ], { onConflict: 'user_id,page_id' });
        expect(mocks.facebook).not.toHaveBeenCalled();
    });

    it('returns a refresh-permissions response only when Facebook authorization has expired', async () => {
        mocks.facebook.mockRejectedValue(Object.assign(new Error('Expired token'), { requiresReauth: true }));
        await expect(verifiedFacebookPages(session)).rejects.toMatchObject({ status: 409 });
        expect(mocks.db).not.toHaveBeenCalled();
    });

    it('preserves an identity mismatch instead of describing it as a Facebook service failure', async () => {
        const db = database([{ id: 'a', fb_page_id: 'fb-a' }]); mocks.db.mockReturnValue(db);
        db.rpc.mockResolvedValueOnce({ data: [{ user_id: 'another-user' }], error: null });
        await expect(verifiedFacebookPages(session)).rejects.toMatchObject({ status: 403 });
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
    it.each(['legacy', 'facebook', 'delegated', 'facebook_messaging'])('lets original Facebook app users administer their existing %s assignments', async grant_source => {
        const db = database([{ id: 'a', fb_page_id: 'fb-a', grant_source }]); mocks.db.mockReturnValue(db); mocks.token.mockResolvedValue(null);
        await requireTeamPageAdministrator(session, ['a']);
        expect(mocks.facebook).not.toHaveBeenCalled();
        expect(db.upsert).toHaveBeenCalledWith([expect.objectContaining({ page_id: 'a', authority_source: 'original' })], expect.anything());
    });
    it.each(['delegated', 'facebook_messaging'])('never promotes a team-created subaccount with a %s grant through a Facebook login', async grant_source => {
        const db = database([{ id: 'a', fb_page_id: 'fb-a', grant_source }], false); mocks.db.mockReturnValue(db);
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
