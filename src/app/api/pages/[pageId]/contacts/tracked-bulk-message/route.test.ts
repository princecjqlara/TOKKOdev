import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    sendCampaignById: vi.fn()
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

vi.mock('@/lib/campaign-send', () => ({
    sendCampaignById: mocks.sendCampaignById
}));

import { POST } from './route';

function createRequest(body: Record<string, unknown>): NextRequest {
    return new Request('http://localhost:3000/api/pages/page_1/contacts/tracked-bulk-message', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    }) as NextRequest;
}

function createSupabaseMock() {
    const userPageSingle = vi.fn().mockResolvedValue({
        data: { page_id: 'page_1' },
        error: null
    });
    const userPageEqPage = vi.fn().mockReturnValue({ single: userPageSingle });
    const userPageEqUser = vi.fn().mockReturnValue({ eq: userPageEqPage });
    const userPageSelect = vi.fn().mockReturnValue({ eq: userPageEqUser });

    const contactsIn = vi.fn((column: string, contactIds: string[]) => Promise.resolve({
        data: contactIds.map((id) => ({ id })),
        error: null
    }));
    const contactsNeq = vi.fn().mockReturnValue({ in: contactsIn });
    const contactsNot = vi.fn().mockReturnValue({ neq: contactsNeq });
    const contactsEq = vi.fn().mockReturnValue({ not: contactsNot });
    const contactsSelect = vi.fn().mockReturnValue({ eq: contactsEq });

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

    const from = vi.fn((table: string) => {
        if (table === 'user_pages') {
            return {
                select: userPageSelect
            };
        }

        if (table === 'contacts') {
            return {
                select: contactsSelect
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

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        campaignsInsert,
        campaignRecipientsInsert
    };
}

describe('POST /api/pages/[pageId]/contacts/tracked-bulk-message', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });
        mocks.sendCampaignById.mockResolvedValue({
            status: 200,
            body: {
                success: true,
                sent: 5,
                failed: 0
            },
            success: true,
            sent: 5,
            failed: 0
        });
    });

    it('creates a campaign only for the requested manual contact batch', async () => {
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest({
            name: 'Manual slice',
            messagePart1: 'Hello',
            envelopeWrapper: 'none',
            selection: {
                mode: 'specific',
                contactIds: Array.from({ length: 12 }, (_, index) => `contact_${index + 1}`),
                slice: {
                    limit: 5,
                    batchNumber: 2
                }
            }
        }), {
            params: Promise.resolve({ pageId: 'page_1' })
        });

        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.recipients).toBe(5);
        expect(body.totalMatched).toBe(12);
        expect(body.selectedRange).toEqual({
            batchSize: 5,
            batchNumber: 2,
            start: 6,
            end: 10,
            totalMatched: 12
        });
        expect(supabase.campaignsInsert).toHaveBeenCalledWith(
            expect.objectContaining({
                total_recipients: 5
            })
        );
        expect(supabase.campaignRecipientsInsert).toHaveBeenCalledWith([
            { campaign_id: 'campaign_1', contact_id: 'contact_6', status: 'pending' },
            { campaign_id: 'campaign_1', contact_id: 'contact_7', status: 'pending' },
            { campaign_id: 'campaign_1', contact_id: 'contact_8', status: 'pending' },
            { campaign_id: 'campaign_1', contact_id: 'contact_9', status: 'pending' },
            { campaign_id: 'campaign_1', contact_id: 'contact_10', status: 'pending' }
        ]);
        expect(mocks.sendCampaignById).toHaveBeenCalledWith(
            expect.objectContaining({
                campaignId: 'campaign_1',
                maxRecipientsPerRun: 250,
                sendBatchSize: 5,
                delayBetweenBatchesMs: 300
            })
        );
    });
});
