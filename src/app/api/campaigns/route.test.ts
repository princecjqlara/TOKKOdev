import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { parseCampaignMessageParts, parseCampaignMessageSequence } from '../../../lib/campaign-message-sequence';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    getSupabaseAdmin: vi.fn()
}));

vi.mock('next-auth', () => ({
    getServerSession: mocks.getServerSession
}));

vi.mock('@/lib/auth', () => ({
    authOptions: {}
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

import { GET, POST } from './route';

function createRequest(body: Record<string, unknown>): NextRequest {
    return new Request('http://localhost:3000/api/campaigns', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    }) as NextRequest;
}

describe('GET /api/campaigns Page isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });
    });
    it('denies workspace requests from an authenticated subaccount with an incomplete first-login profile', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { provider: 'credentials' }, accountActive: true, requiresProfileCompletion: true });
        const response = await GET(new NextRequest('http://localhost:3000/api/campaigns'));
        expect(response.status).toBe(401);
        expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    });

    function listingDatabase(pageIds = ['page_1', 'page_2'], accessError: unknown = null) {
        let records = [
            { id: 'campaign_1', page_id: 'page_1' },
            { id: 'campaign_2', page_id: 'page_2' },
            { id: 'campaign_3', page_id: 'unassigned' }
        ];
        type ListingQuery = {
            select(): ListingQuery;
            in(column: string, ids: string[]): ListingQuery;
            eq(column: string, id: string): ListingQuery;
            order(): ListingQuery;
            range(start: number, end: number): Promise<{ data: typeof records; count: number; error: null }>;
        };
        const query: ListingQuery = {
            select: vi.fn(() => query),
            in: vi.fn((_column: string, ids: string[]) => { records = records.filter(row => ids.includes(row.page_id)); return query; }),
            eq: vi.fn((_column: string, id: string) => { records = records.filter(row => row.page_id === id); return query; }),
            order: vi.fn(() => query),
            range: vi.fn(async (start: number, end: number) => ({ data: records.slice(start, end + 1), count: records.length, error: null }))
        };
        const from = vi.fn((table: string) => {
            if (table === 'user_pages') return { select: () => ({ eq: async () => ({ data: pageIds.map(page_id => ({ page_id })), error: accessError }) }) };
            if (table === 'campaigns') return query;
            throw Error(`Unexpected table: ${table}`);
        });
        mocks.getSupabaseAdmin.mockReturnValue({ from });
        return { from };
    }

    it.each(['', 'page_1', 'page_2'])('returns only the requested assigned Pages: %s', async pageId => {
        listingDatabase();
        const response = await GET(new NextRequest(`http://localhost:3000/api/campaigns?pageId=${pageId}`));
        expect(response.status).toBe(200);
        const expected = [{ id: 'campaign_1', page_id: 'page_1' }, { id: 'campaign_2', page_id: 'page_2' }].filter(row => !pageId || row.page_id === pageId);
        expect(await response.json()).toMatchObject({ items: expected, total: expected.length });
    });

    it.each([{ pageIds: [] }, { pageIds: ['page_1'] }])('rejects a specific unassigned Page without returning other Pages: %j', async ({ pageIds }) => {
        const { from } = listingDatabase(pageIds);
        const response = await GET(new NextRequest('http://localhost:3000/api/campaigns?pageId=unassigned'));
        expect(response.status).toBe(403);
        expect(from).not.toHaveBeenCalledWith('campaigns');
    });

    it('reports an assignment lookup failure instead of showing an empty campaign list', async () => {
        const { from } = listingDatabase([], { code: '08000', message: 'Database unavailable' });
        const response = await GET(new NextRequest('http://localhost:3000/api/campaigns'));
        expect(response.status).toBe(500);
        expect(from).not.toHaveBeenCalledWith('campaigns');
    });

    it('returns an empty list for an account with no Pages when no specific Page was requested', async () => {
        const { from } = listingDatabase([]);
        const response = await GET(new NextRequest('http://localhost:3000/api/campaigns'));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ items: [], total: 0 });
        expect(from).not.toHaveBeenCalledWith('campaigns');
    });
});

function createSupabaseMock(options: {
    contactBestTimes?: Record<string, number | null>;
} = {}) {
    const userPageSingle = vi.fn().mockResolvedValue({
        data: { page_id: 'page_1' },
        error: null
    });
    const userPageEqPage = vi.fn().mockReturnValue({ single: userPageSingle });
    const userPageEqUser = vi.fn().mockReturnValue({ eq: userPageEqPage });
    const userPageSelect = vi.fn().mockReturnValue({ eq: userPageEqUser });

    const campaignSingle = vi.fn().mockResolvedValue({
        data: {
            id: 'campaign_1',
            page_id: 'page_1'
        },
        error: null
    });
    const campaignSelect = vi.fn().mockReturnValue({ single: campaignSingle });
    const campaignsInsert = vi.fn().mockReturnValue({ select: campaignSelect });
    const campaignsUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const campaignsUpdate = vi.fn().mockReturnValue({ eq: campaignsUpdateEq });
    const rpc = vi.fn().mockResolvedValue({
        data: [{
            campaign_id: 'campaign_million',
            recipient_count: 1_000_000,
            total_matched: 1_000_000,
            audience_materialized_at: '2026-08-13T00:00:00.000Z'
        }],
        error: null
    });

    const campaignRecipientsInsert = vi.fn().mockResolvedValue({ error: null });
    const contactsIn = vi.fn((_column: string, contactIds: string[]) => Promise.resolve({
        data: contactIds.map((id) => ({
            id,
            best_contact_hour: options.contactBestTimes?.[id] ?? null
        })),
        error: null
    }));
    const contactsEqPage = vi.fn().mockReturnValue({ in: contactsIn });
    const contactsSelect = vi.fn().mockReturnValue({ eq: contactsEqPage });

    const from = vi.fn((table: string) => {
        if (table === 'tags') return { select: () => ({ in: async (_column: string, ids: string[]) => ({
            data: ids.map(id => ({ id, owner_type: 'page', owner_id: 'page_1', page_id: 'page_1' })), error: null
        }) }) };
        if (table === 'user_pages') {
            return {
                select: userPageSelect
            };
        }

        if (table === 'campaigns') {
            return {
                insert: campaignsInsert,
                update: campaignsUpdate
            };
        }

        if (table === 'campaign_recipients') {
            return {
                insert: campaignRecipientsInsert
            };
        }

        if (table === 'contacts') {
            return {
                select: contactsSelect
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        rpc,
        campaignsInsert,
        campaignsUpdate,
        campaignRecipientsInsert,
        contactsIn
    };
}

describe('POST /api/campaigns', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });
    });

    it('stores scheduled dynamic audience rules without creating recipients yet', async () => {
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest({
            pageId: 'page_1',
            name: 'Spring Follow-up',
            messageText: 'Hello there',
            scheduledAt: '2026-03-22T10:30:00.000Z',
            audienceMode: 'dynamic',
            audienceRules: {
                startDate: '2026-03-01',
                includeTagIds: ['tag_a'],
                excludeTagIds: ['tag_x']
            }
        }));

        expect(response.status).toBe(200);
        expect(supabase.campaignsInsert).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'scheduled',
                scheduled_at: '2026-03-22T10:30:00.000Z',
                audience_mode: 'dynamic',
                audience_start_date: '2026-03-01',
                audience_include_tag_ids: ['tag_a'],
                audience_exclude_tag_ids: ['tag_x']
            })
        );
        expect(supabase.campaignRecipientsInsert).not.toHaveBeenCalled();
    });

    it('stores multiple message parts in order', async () => {
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest({
            pageId: 'page_1',
            name: 'Multi-step follow-up',
            messageText: 'fallback',
            messageParts: ['Send this', 'Then this', 'Then this too'],
            contactIds: ['contact_1']
        }));

        expect(response.status).toBe(200);
        const inserted = supabase.campaignsInsert.mock.calls[0][0];
        expect(parseCampaignMessageSequence(inserted.message_text)).toEqual([
            'Send this',
            'Then this',
            'Then this too'
        ]);
    });

    it('stores per-message template selections in the message sequence', async () => {
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest({
            pageId: 'page_1',
            name: 'Multi-template follow-up',
            messageParts: [
                { text: 'Send this', templateName: 'general_msg_v1', templateLanguage: 'en_US' },
                { text: 'Then this', templateName: 'general_notice_v1', templateLanguage: 'en_US' }
            ],
            contactIds: ['contact_1'],
            templateName: 'general_msg_v1',
            templateLanguage: 'en_US'
        }));

        expect(response.status).toBe(200);
        const inserted = supabase.campaignsInsert.mock.calls[0][0];
        expect(parseCampaignMessageParts(inserted.message_text)).toEqual([
            { text: 'Send this', templateName: 'general_msg_v1', templateLanguage: 'en_US' },
            { text: 'Then this', templateName: 'general_notice_v1', templateLanguage: 'en_US' }
        ]);
        expect(inserted.template_name).toBe('general_msg_v1');
    });

    it('persists media headers so background workers do not depend on browser storage', async () => {
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest({
            pageId: 'page_1',
            name: 'Durable photo campaign',
            messageText: 'Photo update',
            contactIds: ['contact_1'],
            templateName: 'general_msg_v1_media_v2',
            templateLanguage: 'en_US',
            templateMediaHeader: { type: 'image', url: 'https://example.com/photo.jpg' },
            templateMediaHeaders: [{ type: 'image', url: 'https://example.com/photo.jpg' }]
        }));

        expect(response.status).toBe(200);
        expect(supabase.campaignsInsert).toHaveBeenCalledWith(expect.objectContaining({
            template_media_header: { type: 'image', url: 'https://example.com/photo.jpg' },
            template_media_headers: [{ type: 'image', url: 'https://example.com/photo.jpg' }]
        }));
    });

    it('creates a million-contact select-all campaign inside PostgreSQL', async () => {
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest({
            pageId: 'page_1',
            name: 'Million audience',
            messageText: 'Hello everyone',
            selectAll: true,
            selectedTagId: 'tag_1',
            contactIds: []
        }));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.campaign.total_recipients).toBe(1_000_000);
        expect(supabase.rpc).toHaveBeenCalledWith(
            'create_filtered_tracked_bulk_campaign',
            expect.objectContaining({
                p_page_id: 'page_1',
                p_include_tag_ids: ['tag_1'],
                p_slice_limit: null
            })
        );
        expect(supabase.campaignsInsert).not.toHaveBeenCalled();
        expect(supabase.campaignRecipientsInsert).not.toHaveBeenCalled();
    });

    it('schedules best-time recipients on the selected Philippine calendar date', async () => {
        const supabase = createSupabaseMock({
            contactBestTimes: {
                contact_1: 9,
                contact_2: 20
            }
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest({
            pageId: 'page_1',
            name: 'Best time follow-up',
            messageText: 'Hello there',
            contactIds: ['contact_1', 'contact_2'],
            useBestTime: true,
            scheduledDate: '2026-07-30'
        }));

        expect(response.status).toBe(200);
        expect(supabase.campaignRecipientsInsert).toHaveBeenCalledWith([
            {
                campaign_id: 'campaign_1',
                contact_id: 'contact_1',
                status: 'pending',
                scheduled_at: '2026-07-30T01:00:00.000Z'
            },
            {
                campaign_id: 'campaign_1',
                contact_id: 'contact_2',
                status: 'pending',
                scheduled_at: '2026-07-30T12:00:00.000Z'
            }
        ]);
    });

    it('loads large best-time selections in URL-safe query batches', async () => {
        const contactIds = Array.from({ length: 205 }, (_, index) => `contact_${index + 1}`);
        const supabase = createSupabaseMock({
            contactBestTimes: Object.fromEntries(contactIds.map((id, index) => [id, index % 24]))
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest({
            pageId: 'page_1',
            name: 'Large best-time follow-up',
            messageText: 'Hello there',
            contactIds,
            useBestTime: true,
            scheduledDate: '2026-07-30'
        }));

        expect(response.status).toBe(200);
        expect(supabase.contactsIn).toHaveBeenCalledTimes(6);
        expect(supabase.contactsIn.mock.calls.every(call => call[1].length <= 100)).toBe(true);
    });
});
