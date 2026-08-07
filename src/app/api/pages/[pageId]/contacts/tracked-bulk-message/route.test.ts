import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function createBestTimeSupabaseMock() {
    const userPageSingle = vi.fn().mockResolvedValue({
        data: { page_id: 'page_1' },
        error: null
    });
    const userPageEqPage = vi.fn().mockReturnValue({ single: userPageSingle });
    const userPageEqUser = vi.fn().mockReturnValue({ eq: userPageEqPage });
    const userPageSelect = vi.fn().mockReturnValue({ eq: userPageEqUser });

    const campaignIds = ['campaign_1', 'campaign_2', 'campaign_3'];
    const campaignsInsert = vi.fn((payload: Record<string, unknown>) => {
        const id = campaignIds[campaignsInsert.mock.calls.length - 1];
        return {
            select: () => ({
                single: () => Promise.resolve({
                    data: {
                        id,
                        page_id: payload.page_id,
                        scheduled_at: payload.scheduled_at
                    },
                    error: null
                })
            })
        };
    });

    const campaignRecipientsInsert = vi.fn().mockResolvedValue({ error: null });

    const contactsRows = [
        {
            id: 'contact_1',
            best_contact_hour: 9,
            best_contact_hours: [
                { hour: 9, count: 4 },
                { hour: 14, count: 3 },
                { hour: 20, count: 2 }
            ]
        },
        {
            id: 'contact_2',
            best_contact_hour: 10,
            best_contact_hours: [
                { hour: 10, count: 4 },
                { hour: 16, count: 3 },
                { hour: 21, count: 2 }
            ]
        },
        {
            id: 'contact_3',
            best_contact_hour: 11,
            best_contact_hours: [{ hour: 11, count: 1 }]
        }
    ];

    const createCountResult = (count: number) => Promise.resolve({ count, error: null });

    const from = vi.fn((table: string) => {
        if (table === 'user_pages') {
            return {
                select: userPageSelect
            };
        }

        if (table === 'contacts') {
            return {
                select: (columns: string) => {
                    if (columns.includes('best_contact_hours')) {
                        return {
                            eq: () => ({
                                in: (_column: string, contactIds: string[]) => Promise.resolve({
                                    data: contactsRows.filter((contact) => contactIds.includes(contact.id)),
                                    error: null
                                })
                            })
                        };
                    }

                    return {
                        eq: () => ({
                            not: () => ({
                                neq: () => ({
                                    in: (_column: string, contactIds: string[]) => Promise.resolve({
                                        data: contactIds.map((id) => ({ id })),
                                        error: null
                                    })
                                })
                            })
                        })
                    };
                }
            };
        }

        if (table === 'campaigns') {
            return {
                insert: campaignsInsert,
                select: () => ({
                    eq: () => ({
                        in: () => Promise.resolve({
                            data: campaignIds.map((id) => ({
                                id,
                                page_id: 'page_1',
                                total_recipients: 2,
                                sent_count: 0,
                                failed_count: 0
                            })),
                            error: null
                        })
                    })
                })
            };
        }

        if (table === 'campaign_recipients') {
            return {
                insert: campaignRecipientsInsert,
                select: () => ({
                    in: () => ({
                        in: () => createCountResult(6)
                    })
                })
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
        vi.useRealTimers();
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

    afterEach(() => {
        vi.useRealTimers();
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
        expect(body.send).toEqual(expect.objectContaining({
            partial: true,
            sent: 0,
            failed: 0,
            remaining: 5
        }));
        expect(mocks.sendCampaignById).not.toHaveBeenCalled();
    });

    it('schedules three best-time campaigns for tomorrow PH time without sending immediately', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-29T02:00:00.000Z'));
        const supabase = createBestTimeSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest({
            name: 'Best time bulk',
            deliveryMode: 'best_time_next_day',
            scheduledMessages: ['First', 'Second', 'Third'],
            templateName: 'general_msg_v1',
            templateLanguage: 'en_US',
            scheduledMessageTemplates: [
                { templateName: 'general_msg_v1', templateLanguage: 'en_US' },
                { templateName: 'general_notice_v1', templateLanguage: 'en_US' },
                { templateName: 'general_alert_v1', templateLanguage: 'en_US' }
            ],
            envelopeWrapper: 'none',
            selection: {
                mode: 'specific',
                contactIds: ['contact_1', 'contact_2', 'contact_3']
            }
        }), {
            params: Promise.resolve({ pageId: 'page_1' })
        });

        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.mode).toBe('best_time_next_day');
        expect(body.recipients).toBe(2);
        expect(body.skippedContacts).toBe(1);
        expect(body.status).toEqual(expect.objectContaining({
            total: 6,
            sent: 0,
            failed: 0,
            pending: 6,
            allBestTimesSent: false
        }));
        expect(supabase.campaignsInsert).toHaveBeenCalledTimes(3);
        expect(supabase.campaignsInsert).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                scheduled_at: '2026-07-30T01:00:00.000Z',
                template_name: 'general_msg_v1',
                template_language: 'en_US'
            })
        );
        expect(supabase.campaignsInsert).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                scheduled_at: '2026-07-30T06:00:00.000Z',
                template_name: 'general_notice_v1',
                template_language: 'en_US'
            })
        );
        expect(supabase.campaignsInsert).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({
                scheduled_at: '2026-07-30T12:00:00.000Z',
                template_name: 'general_alert_v1',
                template_language: 'en_US'
            })
        );
        expect(supabase.campaignRecipientsInsert).toHaveBeenCalledTimes(3);
        expect(supabase.campaignRecipientsInsert).toHaveBeenNthCalledWith(1, [
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
                scheduled_at: '2026-07-30T02:00:00.000Z'
            }
        ]);
        expect(mocks.sendCampaignById).not.toHaveBeenCalled();
    });
});
