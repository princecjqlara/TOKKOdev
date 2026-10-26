import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from 'next-auth';
const mocks = vi.hoisted(() => ({ facebook: vi.fn(), token: vi.fn(), db: vi.fn() }));
vi.mock('../facebook', () => ({ getFacebookPages: mocks.facebook }));
vi.mock('../server-auth-token', () => ({ getFacebookServerToken: mocks.token }));
vi.mock('../supabase', () => ({ getSupabaseAdmin: mocks.db }));
import { hasFacebookManagementTask, requireFacebookPageManager, verifiedFacebookPages } from '../page-managers';
const session = { user: { id: 'manager', provider: 'facebook', facebookId: 'fb-user' } } as Session;
function database(pageRows: { id: string; fb_page_id: string }[]) {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn((table: string) => {
        if (table === 'user_pages') return { select: () => ({ eq: () => ({ in: async () => ({ data: pageRows.map(page => ({ pages: page })), error: null }) }) }) };
        if (table === 'tokko_page_managers') return { upsert };
        throw Error(`Unexpected ${table}`);
    });
    return { from, upsert, rpc: vi.fn().mockResolvedValue({ data: [{ user_id: 'manager' }], error: null }) };
}
beforeEach(() => { vi.clearAllMocks(); mocks.token.mockResolvedValue('server-only-token'); mocks.facebook.mockResolvedValue([{ id: 'fb-a', tasks: ['MANAGE'] }]); });
describe('verified Facebook manager authority', () => {
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
});
