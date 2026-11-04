import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getSupabaseAdmin: vi.fn(), getPageConversationsBatch: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));
vi.mock('@/lib/facebook', () => ({ getPageConversationsBatch: mocks.getPageConversationsBatch, isFacebookReauthRequired: () => false }));
import { processOneMessagingAutoTagPage } from './messaging-auto-tag-worker';

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-13T00:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const defaultTags = [
    { id: 'qualified', name: 'Qualified', is_default: true },
    { id: 'negative', name: 'Not Qualified', is_default: true },
    { id: 'converted', name: 'Converted', is_default: true },
    { id: 'lost', name: 'Lost', is_default: true }
];
function workerFixture(options: {
    tags?: any[]; restored?: any[]; restoreError?: any; messages?: any[]; eligible?: boolean;
    participants?: any[]; missingContact?: boolean; lastInbound?: string | null; nextCursor?: string | null; contactError?: any;
} = {}) {
    const assignments: any[] = [], checkpoints: any[] = [], filters: any[] = [];
    const page = { id: 'page-1', fb_page_id: 'fb-page', access_token: 'token',
        messaging_auto_tag_checked_at: '2026-10-01T00:00:00Z', messaging_auto_tag_cursor: 'continuation',
        messaging_auto_tag_scan_started_at: '2026-10-10T00:00:00Z' };
    const rpc = vi.fn(async (name: string) => name === 'claim_messaging_auto_tag_page'
        ? { data: [page], error: null }
        : { data: options.restored ?? defaultTags, error: options.restoreError || null });
    const db = { rpc, from: vi.fn((table: string) => {
        const chain: any = {
            select: () => chain, eq: () => chain, in: () => chain,
            gte: (key: string, value: string) => { filters.push(['gte', key, value]); return chain; },
            lte: (key: string, value: string) => { filters.push(['lte', key, value]); return chain; },
            maybeSingle: async () => ({ data: options.missingContact ? null : { id: 'contact-1',
                last_inbound_at: options.lastInbound === undefined ? '2026-10-12T00:00:00Z' : options.lastInbound }, error: options.contactError || null }),
            update: (payload: any) => { checkpoints.push(payload); return chain; },
            upsert: async (rows: any[]) => { assignments.push(...rows); return { error: null }; },
            then: (resolve: any) => Promise.resolve({ data: table === 'tags' ? options.tags ?? defaultTags
                : table === 'contacts' ? options.eligible === false ? [] : [{ psid: 'customer' }] : [], error: null }).then(resolve)
        };
        return chain;
    }) };
    mocks.getSupabaseAdmin.mockReturnValue(db);
    mocks.getPageConversationsBatch.mockResolvedValue({ conversations: [{ id: 'thread', participants: { data:
        options.participants ?? [{ id: 'customer', name: 'Customer' }] } }], nextCursor: options.nextCursor ?? null });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: options.messages ?? [
        { id: 'event', from: { id: 'fb-page' }, message: 'Lead stage set to Converted', created_time: '2026-10-12T00:00:00Z' }
    ] }) });
    vi.stubGlobal('fetch', fetchMock);
    return { rpc, assignments, checkpoints, fetchMock, filters, db };
}

describe('bounded Messenger lead-stage polling', () => {
    it.each([['Qualified', 'qualified'], ['Converted', 'converted'], ['Unqualified', 'negative'],
        ['Not Qualified', 'negative'], ['Lost', 'lost']])('maps %s to its own Page tag', async (stage, tagId) => {
        const fixture = workerFixture({ messages: [{ id: 'event', from: { id: 'fb-page' },
            message: `Lead stage set to ${stage}`, created_time: '2026-10-12T00:00:00Z' }] });
        await expect(processOneMessagingAutoTagPage()).resolves.toMatchObject({ pages: 1, tagged: 1 });
        expect(fixture.assignments).toEqual([{ contact_id: 'contact-1', tag_id: tagId }]);
    });
    it('clamps the initial scan to seven days and filters inbound eligibility before history reads', async () => {
        const fixture = workerFixture({ eligible: false });
        await expect(processOneMessagingAutoTagPage()).resolves.toMatchObject({ tagged: 0 });
        expect(mocks.getPageConversationsBatch).toHaveBeenCalledWith('fb-page', 'token', expect.objectContaining({
            sinceTimestamp: '2026-10-06T00:00:00.000Z', limit: 10
        }));
        expect(fixture.filters).toEqual([['gte', 'last_inbound_at', '2026-10-06T00:00:00.000Z'],
            ['lte', 'last_inbound_at', '2026-10-13T00:00:00.000Z']]);
        expect(fixture.fetchMock).not.toHaveBeenCalled();
    });
    it.each([null, '2026-10-05T23:59:59Z', '2026-10-14T00:00:00Z'])('rechecks an expired or invalid inbound window before tagging: %s', async lastInbound => {
        const fixture = workerFixture({ lastInbound });
        await expect(processOneMessagingAutoTagPage()).resolves.toMatchObject({ tagged: 0 });
        expect(fixture.assignments).toEqual([]);
    });
    it('does not create a new contact or inbound window from a stage event', async () => {
        const fixture = workerFixture({ missingContact: true });
        await expect(processOneMessagingAutoTagPage()).resolves.toMatchObject({ tagged: 0 });
        expect(fixture.assignments).toEqual([]);
    });
    it('restores missing tags before reading history', async () => {
        const fixture = workerFixture({ tags: [] });
        await processOneMessagingAutoTagPage();
        expect(fixture.rpc).toHaveBeenCalledWith('ensure_page_default_tags', { p_page_id: 'page-1' });
        expect(fixture.assignments).toEqual([{ contact_id: 'contact-1', tag_id: 'converted' }]);
    });
    it.each([{ restored: [] }, { restoreError: { message: 'Migration missing' } }])('keeps the checkpoint when tag restoration fails: %j', async options => {
        const fixture = workerFixture({ tags: [], ...options });
        await expect(processOneMessagingAutoTagPage()).rejects.toThrow();
        expect(fixture.fetchMock).not.toHaveBeenCalled();
        expect(fixture.checkpoints).toEqual([expect.objectContaining({ messaging_auto_tag_owner: null })]);
        expect(fixture.checkpoints[0]).not.toHaveProperty('messaging_auto_tag_checked_at');
        expect(fixture.checkpoints[0]).not.toHaveProperty('messaging_auto_tag_cursor');
    });
    it('ignores customer-authored stage text', async () => {
        const fixture = workerFixture({ messages: [{ id: 'event', from: { id: 'customer' },
            message: 'Lead stage set to Converted', created_time: '2026-10-12T00:00:00Z' }] });
        await expect(processOneMessagingAutoTagPage()).resolves.toMatchObject({ tagged: 0 });
        expect(fixture.assignments).toEqual([]);
    });
    it('preserves multiple stage tags and deduplicates repeated events', async () => {
        const fixture = workerFixture({ messages: ['Qualified', 'Converted', 'Not Qualified', 'Lost', 'Converted'].map((stage, index) => ({
            id: `event-${index}`, from: { id: 'fb-page' }, message: `Lead stage set to ${stage}`, created_time: '2026-10-12T00:00:00Z'
        })) });
        await processOneMessagingAutoTagPage();
        expect(fixture.assignments).toEqual(['qualified', 'converted', 'negative', 'lost'].map(tag_id => ({ contact_id: 'contact-1', tag_id })));
        expect(fixture.db.from.mock.calls.map(([table]) => table)).not.toContain('messages');
    });
    it('does not assign a multi-participant conversation to one customer', async () => {
        const fixture = workerFixture({ participants: [{ id: 'a' }, { id: 'b' }] });
        await expect(processOneMessagingAutoTagPage()).resolves.toMatchObject({ tagged: 0 });
        expect(fixture.fetchMock).not.toHaveBeenCalled();
    });
    it('keeps the original scan start across cursor pages', async () => {
        const fixture = workerFixture({ nextCursor: 'next-batch' });
        await processOneMessagingAutoTagPage();
        expect(fixture.checkpoints).toContainEqual(expect.objectContaining({ messaging_auto_tag_checked_at: '2026-10-01T00:00:00Z',
            messaging_auto_tag_cursor: 'next-batch', messaging_auto_tag_scan_started_at: '2026-10-10T00:00:00Z' }));
    });
    it('finishes at the original scan start after the final cursor page', async () => {
        const fixture = workerFixture();
        await processOneMessagingAutoTagPage();
        expect(fixture.checkpoints).toContainEqual(expect.objectContaining({ messaging_auto_tag_checked_at: '2026-10-10T00:00:00Z',
            messaging_auto_tag_scan_started_at: null, messaging_auto_tag_last_error: null }));
    });
    it('keeps the checkpoint after a contact lookup failure', async () => {
        const fixture = workerFixture({ contactError: new Error('Lookup failed') });
        await expect(processOneMessagingAutoTagPage()).rejects.toThrow('Lookup failed');
        expect(fixture.assignments).toEqual([]);
        expect(fixture.checkpoints[0]).not.toHaveProperty('messaging_auto_tag_checked_at');
    });
    it('retries missing message timestamps', async () => {
        const fixture = workerFixture({ messages: [{ id: 'event', from: { id: 'fb-page' }, message: 'Lead stage set to Converted' }] });
        await expect(processOneMessagingAutoTagPage()).rejects.toThrow('missing message identifiers or timestamps');
        expect(fixture.checkpoints[0]).not.toHaveProperty('messaging_auto_tag_checked_at');
    });
    it('rejects insecure pagination before forwarding a Page token', async () => {
        const fixture = workerFixture();
        fixture.fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [], paging: { next: 'http://graph.facebook.com/thread/messages' } }) });
        await expect(processOneMessagingAutoTagPage()).rejects.toThrow('Unexpected Messenger pagination URL');
        expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
        expect(fixture.checkpoints[0]).not.toHaveProperty('messaging_auto_tag_checked_at');
    });
});
