import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getSupabaseAdmin: vi.fn(), getPageConversationsBatch: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));
vi.mock('@/lib/facebook', () => ({ getPageConversationsBatch: mocks.getPageConversationsBatch, isFacebookReauthRequired: () => false }));
import { processOneMessagingAutoTagPage } from './messaging-auto-tag-worker';

afterEach(() => { vi.unstubAllGlobals(); });

describe('tag sync with a single combined default Page tag', () => {
    it.each(['Qualified', 'Unqualified', 'Not Qualified'])('processes %s when the negative tag is not a default', async stage => {
        vi.clearAllMocks();
        const tags = [{ id: 'paid', name: 'Paid / Availed Service', is_default: true },
            { id: 'negative', name: 'Not Qualified', is_default: false }];
        const assignments: any[] = [];
        const checkpoints: any[] = [];
        const page = { id: 'page-1', fb_page_id: 'fb-page', access_token: 'token',
            messaging_auto_tag_checked_at: '2026-10-01T00:00:00Z', messaging_auto_tag_cursor: 'continuation',
            messaging_auto_tag_scan_started_at: '2026-10-10T00:00:00Z' };
        const db = { rpc: vi.fn().mockResolvedValue({ data: [page], error: null }), from: vi.fn((table: string) => {
            let defaultsOnly = false;
            const chain: any = {
                select: () => chain, eq: (key: string) => { if (key === 'is_default') defaultsOnly = true; return chain; },
                order: () => chain, limit: () => chain,
                maybeSingle: async () => ({ data: table === 'pages' ? page : { id: 'contact-1' }, error: null }),
                update: (payload: any) => { checkpoints.push(payload); return chain; },
                upsert: async (rows: any[]) => { assignments.push(...rows); return { error: null }; },
                then: (resolve: any) => Promise.resolve({ data: table === 'tags' ? tags.filter(tag => !defaultsOnly || tag.is_default) : [], error: null }).then(resolve)
            };
            return chain;
        }) };
        mocks.getSupabaseAdmin.mockReturnValue(db);
        mocks.getPageConversationsBatch.mockResolvedValue({ conversations: [{ id: 'thread', participants: { data: [{ id: 'customer' }] } }], nextCursor: null });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{
            id: 'stage-event', from: { id: 'fb-page' }, message: `Lead stage set to ${stage}`, created_time: '2026-10-12T00:00:00Z'
        }] }) }));
        await expect(processOneMessagingAutoTagPage()).resolves.toMatchObject({ pages: 1, tagged: 1 });
        expect(assignments).toEqual([{ contact_id: 'contact-1', tag_id: stage === 'Qualified' ? 'paid' : 'negative' }]);
        expect(checkpoints).toContainEqual(expect.objectContaining({ messaging_auto_tag_last_error: null }));
        expect(checkpoints).toContainEqual(expect.objectContaining({
            messaging_auto_tag_checked_at: '2026-10-10T00:00:00Z', messaging_auto_tag_scan_started_at: null
        }));
    });
});

function workerFixture(options: {
    tags?: any[]; restored?: any[]; restoreError?: any; messages?: any[];
    participants?: any[]; missingContact?: boolean; participantName?: string; nextCursor?: string | null;
} = {}) {
    vi.clearAllMocks();
    const paid = { id: 'paid', name: 'Paid / Availed Service', is_default: true };
    const negative = { id: 'negative', name: 'Unqualified', is_default: true };
    const assignments: any[] = [], checkpoints: any[] = [], inserts: any[] = [];
    const page = { id: 'page-1', fb_page_id: 'fb-page', access_token: 'token',
        messaging_auto_tag_checked_at: '2026-10-01T00:00:00Z', messaging_auto_tag_cursor: 'continuation',
        messaging_auto_tag_scan_started_at: '2026-10-10T00:00:00Z' };
    const rpc = vi.fn(async (name: string) => name === 'claim_messaging_auto_tag_page'
        ? { data: [page], error: null }
        : { data: options.restored ?? [paid, negative], error: options.restoreError || null });
    const db = { rpc, from: vi.fn((table: string) => {
        const chain: any = {
            select: () => chain, eq: () => chain,
            maybeSingle: async () => ({ data: options.missingContact ? null : { id: 'contact-1' }, error: null }),
            single: async () => ({ data: { id: 'contact-1' }, error: null }),
            update: (payload: any) => { checkpoints.push(payload); return chain; },
            insert: (payload: any) => { inserts.push(payload); return chain; },
            upsert: async (rows: any[]) => { assignments.push(...rows); return { error: null }; },
            then: (resolve: any) => Promise.resolve({ data: table === 'tags' ? options.tags ?? [paid, negative] : [], error: null }).then(resolve)
        };
        return chain;
    }) };
    mocks.getSupabaseAdmin.mockReturnValue(db);
    mocks.getPageConversationsBatch.mockResolvedValue({ conversations: [{ id: 'thread', participants: { data:
        options.participants ?? [{ id: 'customer', name: options.participantName || 'Customer' }] } }], nextCursor: options.nextCursor ?? null });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: options.messages ?? [
        { id: 'event', from: { id: 'fb-page' }, message: 'Lead stage set to Converted', created_time: '2026-10-12T00:00:00Z' }
    ] }) });
    vi.stubGlobal('fetch', fetchMock);
    return { rpc, assignments, checkpoints, inserts, fetchMock };
}

describe('auto-tag recovery after cleanup', () => {
    it('restores missing setup tags and applies the observed event', async () => {
        const fixture = workerFixture({ tags: [] });
        await expect(processOneMessagingAutoTagPage()).resolves.toMatchObject({ pages: 1, tagged: 1 });
        expect(fixture.rpc).toHaveBeenCalledWith('ensure_page_default_tags', { p_page_id: 'page-1' });
        expect(fixture.assignments).toEqual([{ contact_id: 'contact-1', tag_id: 'paid' }]);
    });

    it('keeps the scan checkpoint when tag restoration fails', async () => {
        const fixture = workerFixture({ tags: [], restoreError: { code: 'PGRST202', message: 'Migration missing' } });
        await expect(processOneMessagingAutoTagPage()).rejects.toThrow('Could not restore required Page tags');
        expect(fixture.fetchMock).not.toHaveBeenCalled();
        expect(fixture.assignments).toEqual([]);
        expect(fixture.checkpoints).toEqual([expect.objectContaining({ messaging_auto_tag_owner: null })]);
        expect(fixture.checkpoints[0]).not.toHaveProperty('messaging_auto_tag_checked_at');
        expect(fixture.checkpoints[0]).not.toHaveProperty('messaging_auto_tag_cursor');
    });

    it('rejects an incomplete tag repair without reading or advancing the inbox', async () => {
        const fixture = workerFixture({ tags: [], restored: [] });
        await expect(processOneMessagingAutoTagPage()).rejects.toThrow('Required Page tags are missing');
        expect(fixture.fetchMock).not.toHaveBeenCalled();
        expect(fixture.checkpoints[0]).not.toHaveProperty('messaging_auto_tag_checked_at');
    });

    it('does not call repair when the required tags already exist', async () => {
        const fixture = workerFixture();
        await processOneMessagingAutoTagPage();
        expect(fixture.rpc).toHaveBeenCalledTimes(1);
    });

    it('ignores customer-authored stage text', async () => {
        const fixture = workerFixture({ messages: [{ id: 'customer-event', from: { id: 'customer' },
            message: 'Lead stage set to Converted', created_time: '2026-10-12T00:00:00Z' }] });
        await expect(processOneMessagingAutoTagPage()).resolves.toMatchObject({ tagged: 0 });
        expect(fixture.assignments).toEqual([]);
    });

    it('preserves cumulative positive and negative history without duplicate assignments', async () => {
        const fixture = workerFixture({ messages: ['Qualified', 'Converted', 'Unqualified'].map((stage, index) => ({
            id: `event-${index}`, from: { id: 'fb-page' }, message: `Lead stage set to ${stage}`, created_time: '2026-10-12T00:00:00Z'
        })) });
        await processOneMessagingAutoTagPage();
        expect(fixture.assignments).toEqual(expect.arrayContaining([
            { contact_id: 'contact-1', tag_id: 'paid' }, { contact_id: 'contact-1', tag_id: 'negative' }
        ]));
        expect(fixture.assignments).toHaveLength(2);
    });

    it('normalizes a placeholder name when a stage event creates a contact', async () => {
        const fixture = workerFixture({ missingContact: true, participantName: 'Unknown Name' });
        await processOneMessagingAutoTagPage();
        expect(fixture.inserts).toEqual([expect.objectContaining({ page_id: 'page-1', psid: 'customer', name: null })]);
    });

    it('does not assign an ambiguous multi-participant conversation to one customer', async () => {
        const fixture = workerFixture({ participants: [{ id: 'customer-a' }, { id: 'customer-b' }] });
        await expect(processOneMessagingAutoTagPage()).resolves.toMatchObject({ tagged: 0 });
        expect(fixture.fetchMock).not.toHaveBeenCalled();
        expect(fixture.assignments).toEqual([]);
    });

    it('keeps the scan start while another inbox page remains', async () => {
        const fixture = workerFixture({ nextCursor: 'next-batch' });
        await processOneMessagingAutoTagPage();
        expect(fixture.checkpoints).toContainEqual(expect.objectContaining({
            messaging_auto_tag_checked_at: '2026-10-01T00:00:00Z', messaging_auto_tag_cursor: 'next-batch',
            messaging_auto_tag_scan_started_at: '2026-10-10T00:00:00Z'
        }));
    });

    it('retries rather than discarding a message with a missing timestamp', async () => {
        const fixture = workerFixture({ messages: [{ id: 'bad-time', from: { id: 'fb-page' }, message: 'Lead stage set to Converted' }] });
        await expect(processOneMessagingAutoTagPage()).rejects.toThrow('missing message identifiers or timestamps');
        expect(fixture.assignments).toEqual([]);
        expect(fixture.checkpoints[0]).not.toHaveProperty('messaging_auto_tag_checked_at');
    });

    it('rejects an insecure pagination link before forwarding a Page token', async () => {
        const fixture = workerFixture({ messages: [] });
        fixture.fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [], paging: { next: 'http://graph.facebook.com/thread/messages' } }) });
        await expect(processOneMessagingAutoTagPage()).rejects.toThrow('Unexpected Messenger pagination URL');
        expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
        expect(fixture.checkpoints[0]).not.toHaveProperty('messaging_auto_tag_checked_at');
    });
});
