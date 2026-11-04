import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSupabaseAdmin: vi.fn(),
    getPageConversations: vi.fn(),
    getUserProfile: vi.fn(),
    getConversationMessages: vi.fn(),
    repairMissingContactNamesForPage: vi.fn()
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/facebook', () => ({
    getPageConversations: mocks.getPageConversations,
    getUserProfile: mocks.getUserProfile,
    getConversationMessages: mocks.getConversationMessages
}));

vi.mock('../../../../lib/contact-name-repair', () => ({
    repairMissingContactNamesForPage: mocks.repairMissingContactNamesForPage
}));

function createRequest(): NextRequest {
    return new Request('http://localhost:3000/api/cron/sync', {
        method: 'GET'
    }) as NextRequest;
}

function createSupabaseMock(options: { autoTagEnabled?: boolean } = {}) {
    const pagesLimit = vi.fn().mockResolvedValue({
        data: [
            {
                id: 'page_1',
                fb_page_id: 'fb_page_1',
                access_token: 'page_access_token_1',
                name: 'Test Page',
                updated_at: '2026-04-07T02:00:00.000Z',
                messaging_auto_tag_enabled: options.autoTagEnabled ?? true
            }
        ],
        error: null
    });
    const pagesOrder = vi.fn().mockReturnValue({
        limit: pagesLimit
    });
    const pagesSelect = vi.fn().mockReturnValue({
        order: pagesOrder
    });
    const pagesEq = vi.fn().mockResolvedValue({ error: null });
    const pagesUpdate = vi.fn().mockReturnValue({
        eq: pagesEq
    });

    const contactsUpsert = vi.fn().mockResolvedValue({ error: null });
    const contactChain: any = { eq: () => contactChain,
        maybeSingle: async () => ({ data: { id: 'contact_1' }, error: null }) };
    const tagAssignments = vi.fn().mockResolvedValue({ error: null });
    const tagChain: any = { select: () => tagChain, eq: () => tagChain,
        then: (resolve: any) => Promise.resolve({ data: [
            { id: 'paid_tag', name: 'Paid / Availed Service', is_default: true },
            { id: 'negative_tag', name: 'Unqualified', is_default: true }
        ], error: null }).then(resolve) };

    const from = vi.fn((table: string) => {
        if (table === 'tags') return tagChain;
        if (table === 'contact_tags') return { upsert: tagAssignments };
        if (table === 'pages') {
            return {
                select: pagesSelect,
                update: pagesUpdate
            };
        }

        if (table === 'contacts') {
            return {
                upsert: contactsUpsert,
                select: () => contactChain
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        pagesLimit,
        pagesOrder,
        pagesUpdate,
        pagesEq,
        contactsUpsert,
        tagAssignments
    };
}

async function loadRoute() {
    vi.resetModules();
    return import('./route');
}

describe('GET /api/cron/sync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        mocks.getConversationMessages.mockResolvedValue([]);
        mocks.repairMissingContactNamesForPage.mockResolvedValue({
            checked: 0,
            repaired: 0,
            cleared: 0,
            failed: 0
        });
    });

    it('updates Messenger tags after saving a fetched contact', async () => {
        const { GET } = await loadRoute();
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getPageConversations.mockResolvedValue([{ id: 'conversation_1', updated_time: '2026-04-07T02:00:00Z',
            participants: { data: [{ id: 'contact_psid_1', name: 'Jane Contact' }] } }]);
        mocks.getUserProfile.mockResolvedValue({ name: 'Jane Contact' });
        mocks.getConversationMessages.mockResolvedValue([{ id: 'stage', from: { id: 'fb_page_1' },
            message: 'Lead stage set to Qualified', created_time: '2026-04-07T02:00:00Z' }]);

        const response = await GET(createRequest());

        expect((await response.json()).results[0]).toMatchObject({ synced: 1, failed: 0, tagged: 1 });
        expect(supabase.tagAssignments).toHaveBeenCalledWith([{ contact_id: 'contact_1', tag_id: 'paid_tag' }],
            { onConflict: 'contact_id,tag_id', ignoreDuplicates: true });
    });

    it('counts a rejected contact save as failed and does not tag it', async () => {
        const { GET } = await loadRoute();
        const supabase = createSupabaseMock();
        supabase.contactsUpsert.mockResolvedValue({ error: { message: 'Database unavailable' } });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getPageConversations.mockResolvedValue([{ id: 'conversation_1', updated_time: '2026-04-07T02:00:00Z',
            participants: { data: [{ id: 'contact_psid_1', name: 'Jane Contact' }] } }]);
        mocks.getUserProfile.mockResolvedValue({ name: 'Jane Contact' });

        const response = await GET(createRequest());

        expect((await response.json()).results[0]).toMatchObject({ synced: 0, failed: 1, tagged: 0 });
        expect(mocks.getConversationMessages).not.toHaveBeenCalled();
        expect(supabase.tagAssignments).not.toHaveBeenCalled();
    });

    it('skips history tagging when the Page setting is off', async () => {
        const { GET } = await loadRoute();
        const supabase = createSupabaseMock({ autoTagEnabled: false });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getPageConversations.mockResolvedValue([{ id: 'conversation_1', updated_time: '2026-04-07T02:00:00Z',
            participants: { data: [{ id: 'contact_psid_1', name: 'Jane Contact' }] } }]);
        mocks.getUserProfile.mockResolvedValue({ name: 'Jane Contact' });

        const response = await GET(createRequest());

        expect((await response.json()).results[0]).toMatchObject({ synced: 1, failed: 0, tagged: 0 });
        expect(mocks.getConversationMessages).not.toHaveBeenCalled();
    });

    it('keeps the participant name when profile lookup returns placeholder UNKNOWN', async () => {
        const { GET } = await loadRoute();
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getPageConversations.mockResolvedValue([
            {
                id: 'conversation_1',
                updated_time: '2026-04-07T02:00:00.000Z',
                participants: {
                    data: [
                        { id: 'fb_page_1', name: 'Test Page' },
                        { id: 'contact_psid_1', name: 'Jane Contact' }
                    ]
                }
            }
        ]);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'UNKNOWN',
            profile_pic: 'https://example.com/jane.jpg'
        });

        const response = await GET(createRequest());

        expect(response.status).toBe(200);
        expect(mocks.getPageConversations).toHaveBeenCalledWith(
            'fb_page_1',
            'page_access_token_1',
            5,
            false
        );
        expect(mocks.repairMissingContactNamesForPage).toHaveBeenCalledWith(
            supabase,
            expect.objectContaining({ id: 'page_1' }),
            { limit: 20 }
        );
        expect(supabase.pagesOrder).toHaveBeenCalledWith(
            'updated_at',
            { ascending: true, nullsFirst: true }
        );
        expect(supabase.pagesLimit).toHaveBeenCalledWith(1);
        expect(supabase.pagesUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                updated_at: expect.any(String)
            })
        );
        expect(supabase.pagesEq).toHaveBeenCalledWith('id', 'page_1');
        const payload = supabase.contactsUpsert.mock.calls[0][0] as Record<string, unknown>;
        expect(payload.name).toBe('Jane Contact');
        expect(payload.profile_pic).toBe('https://example.com/jane.jpg');
    });

    it('omits placeholder names when no usable contact name is available', async () => {
        const { GET } = await loadRoute();
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getPageConversations.mockResolvedValue([
            {
                id: 'conversation_1',
                updated_time: '2026-04-07T02:00:00.000Z',
                participants: {
                    data: [
                        { id: 'fb_page_1', name: 'Test Page' },
                        { id: 'contact_psid_1', name: 'UNKNOWN' }
                    ]
                }
            }
        ]);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'UNKNOWN',
            profile_pic: 'https://example.com/unknown.jpg'
        });

        const response = await GET(createRequest());

        expect(response.status).toBe(200);
        const payload = supabase.contactsUpsert.mock.calls[0][0] as Record<string, unknown>;
        expect(payload).not.toHaveProperty('name');
        expect(payload.profile_pic).toBe('https://example.com/unknown.jpg');
    });
});
