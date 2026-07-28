import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendCampaignById } from '../campaign-send';
import { serializeCampaignMessageSequence } from '../campaign-message-sequence';
import { sendMessage } from '../facebook';

vi.mock('../facebook', () => ({
    sendMessage: vi.fn(),
    getConversationIdForPsid: vi.fn(),
    getConversationMessages: vi.fn()
}));

vi.mock('../ai', () => ({
    generatePersonalizedMessage: vi.fn()
}));

function createSupabaseMock(
    campaignStatus: 'draft' | 'scheduled' = 'scheduled',
    options: {
        messageText?: string;
        recipients?: { id: string; contact_id: string; contacts: { psid: string; name?: string } }[];
        remainingPendingCount?: number;
    } = {}
) {
    const campaignRecord = {
        id: 'campaign_1',
        page_id: 'page_1',
        status: campaignStatus,
        message_text: options.messageText || 'Hello there',
        use_ai_message: false,
        is_loop: false,
        ai_prompt: null,
        pages: {
            fb_page_id: 'fb_page_1',
            access_token: 'page_token',
            id: 'page_1'
        }
    };

    const campaignSingle = vi.fn().mockResolvedValue({
        data: campaignRecord,
        error: null
    });
    const campaignEqId = vi.fn().mockReturnValue({ single: campaignSingle });
    const campaignSelect = vi.fn().mockReturnValue({ eq: campaignEqId });

    const campaignUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const campaignUpdate = vi.fn().mockReturnValue({ eq: campaignUpdateEq });

    const userPageSingle = vi.fn().mockResolvedValue({
        data: { page_id: 'page_1' },
        error: null
    });
    const userPageEqPage = vi.fn().mockReturnValue({ single: userPageSingle });
    const userPageEqUser = vi.fn().mockReturnValue({ eq: userPageEqPage });
    const userPageSelect = vi.fn().mockReturnValue({ eq: userPageEqUser });

    const recipientsRange = vi.fn((from: number, to: number) => Promise.resolve({
        data: (options.recipients || []).slice(from, to + 1),
        error: null
    }));
    const recipientsOr = vi.fn().mockReturnValue({ range: recipientsRange });
    const recipientsEqStatus = vi.fn().mockReturnValue({ range: recipientsRange, or: recipientsOr });
    const recipientsEqCampaign = vi.fn().mockReturnValue({ eq: recipientsEqStatus });
    let sentCount = 0;
    let failedCount = 0;
    let pendingCount = (options.recipients?.length || 0) + (options.remainingPendingCount || 0);
    const recipientsCountEqStatus = vi.fn((_column: string, status: string) => Promise.resolve({
        count:
            status === 'sent'
                ? sentCount
                : status === 'failed'
                    ? failedCount
                    : status === 'pending'
                        ? pendingCount
                        : 0,
        error: null
    }));
    const recipientsCountEqCampaign = vi.fn().mockReturnValue({ eq: recipientsCountEqStatus });
    const recipientsSelect = vi.fn((_columns: string, queryOptions?: { head?: boolean }) => {
        if (queryOptions?.head) {
            return { eq: recipientsCountEqCampaign };
        }

        return { eq: recipientsEqCampaign };
    });
    const recipientsUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const recipientsUpdate = vi.fn((updates: { status?: string }) => {
        if (updates.status === 'sent') {
            sentCount += 1;
            pendingCount = Math.max(0, pendingCount - 1);
        }

        if (updates.status === 'failed') {
            failedCount += 1;
            pendingCount = Math.max(0, pendingCount - 1);
        }

        return { eq: recipientsUpdateEq };
    });

    const from = vi.fn((table: string) => {
        if (table === 'campaigns') {
            return {
                select: campaignSelect,
                update: campaignUpdate
            };
        }

        if (table === 'user_pages') {
            return {
                select: userPageSelect
            };
        }

        if (table === 'campaign_recipients') {
            return {
                select: recipientsSelect,
                update: recipientsUpdate
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        campaignUpdate,
        campaignUpdateEq,
        recipientsUpdate,
        recipientsOr,
        recipientsRange
    };
}

describe('sendCampaignById', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('blocks scheduled campaigns from the manual send path', async () => {
        const supabase = createSupabaseMock('scheduled');

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never,
            userId: 'user_1'
        });

        expect(result.status).toBe(400);
        expect(result.body.message).toBe('Campaign has already been completed or cancelled');
    });

    it('allows scheduled campaigns from cron and completes cleanly when no recipients are pending', async () => {
        const supabase = createSupabaseMock('scheduled');

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never,
            allowScheduled: true
        });

        expect(result.status).toBe(200);
        expect(result.success).toBe(true);
        expect(result.sent).toBe(0);
        expect(result.failed).toBe(0);
        expect(supabase.campaignUpdate).toHaveBeenCalledTimes(2);
        expect(supabase.campaignUpdate).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ status: 'sending' })
        );
        expect(supabase.campaignUpdate).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ status: 'completed', failed_count: 0 })
        );
    });

    it('sends multiple campaign message parts to each recipient in order', async () => {
        const supabase = createSupabaseMock('draft', {
            messageText: serializeCampaignMessageSequence(['First message', 'Second message']),
            recipients: [{
                id: 'recipient_1',
                contact_id: 'contact_1',
                contacts: {
                    psid: 'psid_1',
                    name: 'Alex'
                }
            }]
        });
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'mid_1' });

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never
        });

        expect(result.status).toBe(200);
        expect(sendMessage).toHaveBeenCalledTimes(2);
        expect(sendMessage).toHaveBeenNthCalledWith(
            1,
            'fb_page_1',
            'page_token',
            'psid_1',
            'First message',
            'HUMAN_AGENT',
            undefined,
            undefined,
            undefined
        );
        expect(sendMessage).toHaveBeenNthCalledWith(
            2,
            'fb_page_1',
            'page_token',
            'psid_1',
            'Second message',
            'HUMAN_AGENT',
            undefined,
            undefined,
            undefined
        );
    });

    it('retries transient send failures before marking a recipient failed', async () => {
        const supabase = createSupabaseMock('draft', {
            recipients: [{
                id: 'recipient_1',
                contact_id: 'contact_1',
                contacts: {
                    psid: 'psid_1',
                    name: 'Alex'
                }
            }]
        });
        vi.mocked(sendMessage)
            .mockRejectedValueOnce(new Error('fetch failed'))
            .mockResolvedValueOnce({ message_id: 'mid_retry' });

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never,
            sendRetryAttempts: 1,
            sendRetryDelayMs: 0
        });

        expect(result.status).toBe(200);
        expect(result.sent).toBe(1);
        expect(result.failed).toBe(0);
        expect(sendMessage).toHaveBeenCalledTimes(2);
        expect(supabase.recipientsUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'sent' })
        );
        expect(supabase.recipientsUpdate).not.toHaveBeenCalledWith(
            expect.objectContaining({ status: 'failed' })
        );
    });

    it('fetches every pending recipient page without a per-run recipient cap', async () => {
        const recipients = Array.from({ length: 2001 }, (_, index) => ({
            id: `recipient_${index + 1}`,
            contact_id: `contact_${index + 1}`,
            contacts: {
                psid: `psid_${index + 1}`,
                name: `Contact ${index + 1}`
            }
        }));
        const supabase = createSupabaseMock('draft', { recipients });
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'mid_bulk' });

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never,
            sendBatchSize: 25,
            delayBetweenBatchesMs: 0
        });

        expect(result.status).toBe(200);
        expect(result.sent).toBe(2001);
        expect(result.failed).toBe(0);
        expect(sendMessage).toHaveBeenCalledTimes(2001);
        expect(supabase.recipientsRange).toHaveBeenNthCalledWith(1, 0, 1999);
        expect(supabase.recipientsRange).toHaveBeenNthCalledWith(2, 2000, 3999);
    });

    it('caps fetched recipients for short cron runs', async () => {
        const recipients = Array.from({ length: 50 }, (_, index) => ({
            id: `recipient_${index + 1}`,
            contact_id: `contact_${index + 1}`,
            contacts: {
                psid: `psid_${index + 1}`,
                name: `Contact ${index + 1}`
            }
        }));
        const supabase = createSupabaseMock('scheduled', { recipients });
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'mid_limited' });

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never,
            allowScheduled: true,
            dueAt: '2026-07-20T10:00:00.000Z',
            sendBatchSize: 5,
            delayBetweenBatchesMs: 0,
            maxRecipientsPerRun: 10
        });

        expect(result.status).toBe(200);
        expect(result.body.partial).toBe(true);
        expect(result.sent).toBe(10);
        expect(sendMessage).toHaveBeenCalledTimes(10);
        expect(supabase.recipientsRange).toHaveBeenCalledTimes(1);
        expect(supabase.recipientsRange).toHaveBeenCalledWith(0, 9);
    });

    it('cron sends only due recipients and keeps campaign scheduled while future recipients remain', async () => {
        const supabase = createSupabaseMock('scheduled', {
            remainingPendingCount: 1,
            recipients: [{
                id: 'recipient_due',
                contact_id: 'contact_1',
                contacts: {
                    psid: 'psid_1',
                    name: 'Alex'
                }
            }]
        });
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'mid_due' });

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never,
            allowScheduled: true,
            dueAt: '2026-07-20T10:00:00.000Z'
        });

        expect(result.status).toBe(200);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(supabase.recipientsOr).toHaveBeenCalledWith(
            'scheduled_at.lte.2026-07-20T10:00:00.000Z,next_scheduled_at.lte.2026-07-20T10:00:00.000Z'
        );
        expect(supabase.campaignUpdate).toHaveBeenLastCalledWith(
            expect.objectContaining({
                status: 'scheduled',
                sent_count: 1,
                failed_count: 0
            })
        );
    });

    it('cron includes unscheduled recipients when the campaign-level schedule is due', async () => {
        const supabase = createSupabaseMock('scheduled', {
            recipients: [{
                id: 'recipient_1',
                contact_id: 'contact_1',
                contacts: {
                    psid: 'psid_1',
                    name: 'Alex'
                }
            }]
        });
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'mid_due' });

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never,
            allowScheduled: true,
            dueAt: '2026-07-20T10:00:00.000Z',
            includeUnscheduledRecipients: true
        });

        expect(result.status).toBe(200);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(supabase.recipientsOr).toHaveBeenCalledWith(
            'scheduled_at.is.null,scheduled_at.lte.2026-07-20T10:00:00.000Z,next_scheduled_at.lte.2026-07-20T10:00:00.000Z'
        );
    });
});
