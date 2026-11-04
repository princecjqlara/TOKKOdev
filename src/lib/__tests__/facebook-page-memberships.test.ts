import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from 'next-auth';
import { AccessError } from '../account-security';
const mocks = vi.hoisted(() => ({ verified: vi.fn() }));
vi.mock('../page-managers', () => ({ verifiedFacebookPages: mocks.verified }));
import { restoreFacebookPageMemberships } from '../facebook-page-memberships';

const session = { user: { id: 'facebook_user', provider: 'facebook', facebookId: 'subject' } } as Session;
function fixture(options: { rows?: any[]; readError?: any; writeError?: any } = {}) {
    const reads: string[][] = [];
    const upsert = vi.fn().mockResolvedValue({ error: options.writeError || null });
    const from = vi.fn((table: string) => {
        if (table === 'pages') return { select: vi.fn(() => ({ in: async (_key: string, ids: string[]) => {
            reads.push(ids);
            return { data: options.rows || ids.map(id => ({ id: `stored-${id}`, fb_page_id: id })), error: options.readError || null };
        } })) };
        if (table === 'user_pages') return { upsert };
        throw Error(`Unexpected table: ${table}`);
    });
    return { db: { from } as any, from, reads, upsert };
}
beforeEach(() => {
    vi.clearAllMocks(); mocks.verified.mockResolvedValue([{ id: 'page_1', access_token: 'server_only', tasks: ['MANAGE'] }]);
});

describe('automatic Page recovery for direct Facebook sign-in', () => {
    it('links the existing shared Page after Facebook verifies its manager', async () => {
        const f = fixture();
        expect(await restoreFacebookPageMemberships(session, f.db)).toBe(1);
        expect(f.upsert).toHaveBeenCalledWith([{ user_id: 'facebook_user', page_id: 'stored-page_1', grant_source: 'facebook' }],
            { onConflict: 'user_id,page_id', ignoreDuplicates: true });
        expect(f.from.mock.calls.map(([table]) => table)).toEqual(['pages', 'user_pages']);
        expect(mocks.verified).toHaveBeenCalledWith(session, 'messaging');
        expect(JSON.stringify(f.upsert.mock.calls)).not.toContain('server_only');
    });
    it.each(['PROFILE_PLUS_MANAGE', 'PROFILE_PLUS_FULL_CONTROL'])('restores access for the modern management task %s', async task => {
        mocks.verified.mockResolvedValue([{ id: 'page_1', access_token: 'token', tasks: [task] }]);
        const f = fixture();
        expect(await restoreFacebookPageMemberships(session, f.db)).toBe(1);
    });
    it.each(['MESSAGING', 'PROFILE_PLUS_MESSAGING', 'PAGES_MESSAGING'])('automatically grants shared Page use for %s without team administration', async task => {
        mocks.verified.mockResolvedValue([{ id: 'page_1', access_token: 'token', tasks: [task] }]);
        const f = fixture();
        expect(await restoreFacebookPageMemberships(session, f.db)).toBe(1);
        expect(f.upsert).toHaveBeenCalledWith([{ user_id: 'facebook_user', page_id: 'stored-page_1', grant_source: 'facebook_messaging' }],
            { onConflict: 'user_id,page_id', ignoreDuplicates: true });
    });
    it.each(['PROFILE_PLUS_FACEBOOK_ACCESS', 'ANALYZE', 'MODERATE'])('does not grant messaging or contact access from %s alone', async task => {
        mocks.verified.mockResolvedValue([{ id: 'page_1', access_token: 'token', tasks: [task] }]);
        const f = fixture();
        expect(await restoreFacebookPageMemberships(session, f.db)).toBe(0);
        expect(f.from).not.toHaveBeenCalled();
    });

    it('asks a recognized manager for Page consent instead of saying they lack management access', async () => {
        mocks.verified.mockResolvedValue([{ id: 'page_1', tasks: ['PROFILE_PLUS_FULL_CONTROL'] }]);
        const f = fixture();
        await expect(restoreFacebookPageMemberships(session, f.db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('recognizes your Page access') });
        expect(f.from).not.toHaveBeenCalled();
    });
    it('never grants access to an unverified Facebook Page ID', async () => {
        const f = fixture({ rows: [{ id: 'foreign_page', fb_page_id: 'unverified' }] });
        expect(await restoreFacebookPageMemberships(session, f.db)).toBe(0);
        expect(f.upsert).not.toHaveBeenCalled();
    });
    it('does not create new Page rows, replace tokens, or start a new import', async () => {
        const f = fixture({ rows: [] });
        expect(await restoreFacebookPageMemberships(session, f.db)).toBe(0);
        expect(f.from.mock.calls.map(([table]) => table)).toEqual(['pages']);
    });
    it('keeps provider tokens and identity verification on the server', async () => {
        mocks.verified.mockRejectedValue(new AccessError(403, 'Identity mismatch'));
        const f = fixture();
        await expect(restoreFacebookPageMemberships(session, f.db)).rejects.toMatchObject({ status: 403 });
        expect(f.from).not.toHaveBeenCalled();
    });
    it('does not attempt Facebook recovery for an email subaccount', async () => {
        const f = fixture();
        expect(await restoreFacebookPageMemberships({ user: { id: 'member', provider: 'credentials' } } as Session, f.db)).toBe(0);
        expect(mocks.verified).not.toHaveBeenCalled(); expect(f.from).not.toHaveBeenCalled();
    });
    it('bounds queries and ignores duplicate Facebook Page IDs', async () => {
        const pages = Array.from({ length: 251 }, (_, i) => ({ id: `page-${i}`, tasks: ['MANAGE'], access_token: 'token' }));
        mocks.verified.mockResolvedValue([...pages, pages[0]]);
        const f = fixture();
        expect(await restoreFacebookPageMemberships(session, f.db)).toBe(251);
        expect(f.reads.map(ids => ids.length)).toEqual([100, 100, 51]);
        expect(f.upsert).toHaveBeenCalledTimes(3);
    });
    it.each(['readError', 'writeError'])('reports a failed %s instead of claiming Page recovery succeeded', async key => {
        const f = fixture({ [key]: { message: 'Database unavailable' } });
        await expect(restoreFacebookPageMemberships(session, f.db)).rejects.toMatchObject({ message: 'Database unavailable' });
    });
});
