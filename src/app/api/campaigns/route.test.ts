import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
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

import { POST } from './route';

function createRequest(body: Record<string, unknown>): NextRequest {
    return new Request('http://localhost:3000/api/campaigns', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    }) as NextRequest;
}

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

    const campaignRecipientsInsert = vi.fn().mockResolvedValue({ error: null });
    const contactsIn = vi.fn((_column: string, contactIds: string[]) => Promise.resolve({
        data: contactIds.map((id) => ({
            id,
            best_contact_hour: options.contactBestTimes?.[id] ?? null
        })),
        error: null
    }));
    const contactsSelect = vi.fn().mockReturnValue({ in: contactsIn });

    const from = vi.fn((table: string) => {
        if (table === 'user_pages') {
            return {
                select: userPageSelect
            };
        }

        if (table === 'campaigns') {
            return {
                insert: campaignsInsert
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
        campaignsInsert,
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
});
