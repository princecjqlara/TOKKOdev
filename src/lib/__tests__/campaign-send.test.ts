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
        total_recipients: (options.recipients?.length || 0) + (options.remainingPendingCount || 0),
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

    const campaignUpdateEq = vi.fn();
    const campaignUpdate = vi.fn().mockImplementation((updates: Record<string, unknown>) => {
        if (typeof updates.status === 'string') campaignRecord.status = updates.status as typeof campaignRecord.status;
        const query: any = {
            eq: vi.fn(() => query),
            then: (resolve: (value: { error: null }) => unknown) => Promise.resolve({ error: null }).then(resolve)
        };
        campaignUpdateEq.mockImplementation(query.eq);
        return query;
    });

    const userPageSingle = vi.fn().mockResolvedValue({
        data: { page_id: 'page_1' },
        error: null
    });
    const userPageEqPage = vi.fn().mockReturnValue({ single: userPageSingle });
    const userPageEqUser = vi.fn().mockReturnValue({ eq: userPageEqPage });
    const userPageSelect = vi.fn().mockReturnValue({ eq: userPageEqUser });

    let sentCount = 0;
    let failedCount = 0;
    const pendingRecipients = [...(options.recipients || [])];
    const fixedRemaining = options.remainingPendingCount || 0;
    const claimRpc = vi.fn();
    const finishBatchRpc = vi.fn();
    const rpc = vi.fn(async (name: string, args: Record<string, any>) => {
        if (name === 'claim_campaign_recipients') {
            claimRpc(args);
            const claimed = pendingRecipients.splice(0, args.p_batch_size).map(recipient => ({
                contact_id: recipient.contact_id,
                contact_psid: recipient.contacts.psid,
                contact_name: recipient.contacts.name || null,
                contact_best_hour: null,
                claim_token: 'claim_token_1'
            }));
            return { data: claimed, error: null };
        }

        if (name === 'finish_campaign_recipient_batch') {
            finishBatchRpc(args);
            for (const result of args.p_results) {
                if (result.success) sentCount += 1;
                else failedCount += 1;
            }
            return { data: args.p_results.length, error: null };
        }

        if (name === 'get_campaign_delivery_progress') {
            return {
                data: [{
                    sent_count: sentCount,
                    failed_count: failedCount,
                    remaining_count: pendingRecipients.length + fixedRemaining
                }],
                error: null
            };
        }

        throw new Error(`Unexpected RPC: ${name}`);
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

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        rpc,
        campaignUpdate,
        campaignUpdateEq,
        claimRpc,
        finishBatchRpc
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
            expect.objectContaining({ status: 'completed' })
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

    it('uses per-message templates when sending multiple campaign parts', async () => {
        const supabase = createSupabaseMock('draft', {
            messageText: serializeCampaignMessageSequence([
                { text: 'First message', templateName: 'general_msg_v1', templateLanguage: 'en_US' },
                { text: 'Second message', templateName: 'general_notice_v1', templateLanguage: 'en_US' }
            ]),
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
            'UTILITY',
            'general_msg_v1',
            'en_US',
            ['First message']
        );
        expect(sendMessage).toHaveBeenNthCalledWith(
            2,
            'fb_page_1',
            'page_token',
            'psid_1',
            'Second message',
            'UTILITY',
            'general_notice_v1',
            'en_US',
            ['Second message']
        );
    });

    it('uses per-message media headers when sending multiple template parts', async () => {
        const supabase = createSupabaseMock('draft', {
            messageText: serializeCampaignMessageSequence([
                { text: 'First message', templateName: 'general_msg_v1_media_v1', templateLanguage: 'en_US' },
                { text: 'Second message', templateName: 'general_notice_v1_media_v1', templateLanguage: 'en_US' }
            ]),
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
            supabase: supabase as never,
            templateMediaHeaders: [
                { type: 'image', url: 'https://example.com/first.jpg' },
                { type: 'image', url: 'https://example.com/second.jpg' }
            ]
        });

        expect(result.status).toBe(200);
        expect(sendMessage).toHaveBeenCalledTimes(2);
        expect(sendMessage).toHaveBeenNthCalledWith(
            1,
            'fb_page_1',
            'page_token',
            'psid_1',
            'First message',
            'UTILITY',
            'general_msg_v1_media_v1',
            'en_US',
            ['First message'],
            undefined,
            { type: 'image', url: 'https://example.com/first.jpg' }
        );
        expect(sendMessage).toHaveBeenNthCalledWith(
            2,
            'fb_page_1',
            'page_token',
            'psid_1',
            'Second message',
            'UTILITY',
            'general_notice_v1_media_v1',
            'en_US',
            ['Second message'],
            undefined,
            { type: 'image', url: 'https://example.com/second.jpg' }
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
        expect(supabase.finishBatchRpc).toHaveBeenCalledWith(expect.objectContaining({
            p_results: [{ contact_id: 'contact_1', success: true, error_message: null }]
        }));
    });

    it('claims every pending recipient in bounded atomic batches without a per-run cap', async () => {
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
        expect(supabase.claimRpc).toHaveBeenCalledTimes(82);
        expect(supabase.claimRpc).toHaveBeenNthCalledWith(1, expect.objectContaining({ p_batch_size: 25 }));
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
        expect(supabase.claimRpc).toHaveBeenCalledTimes(2);
        expect(supabase.claimRpc).toHaveBeenLastCalledWith(expect.objectContaining({ p_batch_size: 5 }));
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
        expect(supabase.claimRpc).toHaveBeenCalledWith(expect.objectContaining({
            p_due_at: '2026-07-20T10:00:00.000Z',
            p_include_unscheduled: false
        }));
        expect(supabase.campaignUpdate).toHaveBeenLastCalledWith(
            expect.objectContaining({
                status: 'scheduled'
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
        expect(supabase.claimRpc).toHaveBeenCalledWith(expect.objectContaining({
            p_due_at: '2026-07-20T10:00:00.000Z',
            p_include_unscheduled: true
        }));
    });
});
