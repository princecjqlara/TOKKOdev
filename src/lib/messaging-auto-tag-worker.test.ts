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
