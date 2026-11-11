import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATABASE_REQUEST_TIMEOUT_MS } from '../database-request';
import { sendCampaignById } from '../campaign-send';
import { serializeCampaignMessageSequence } from '../campaign-message-sequence';
import { getPageTemplates, sendMessage, takeThreadControl } from '../facebook';
import { waitForPageDeliveryBatch } from '../page-delivery';

vi.mock('../facebook', () => ({
    sendMessage: vi.fn(),
    getPageTemplates: vi.fn(),
    takeThreadControl: vi.fn(),
    getConversationIdForPsid: vi.fn(),
    getConversationMessages: vi.fn()
}));

vi.mock('../ai', () => ({
    generatePersonalizedMessage: vi.fn()
}));

vi.mock('../page-delivery', async importOriginal => ({
    ...await importOriginal<typeof import('../page-delivery')>(), waitForPageDeliveryBatch: vi.fn().mockResolvedValue(undefined)
}));

function createSupabaseMock(
    campaignStatus: 'draft' | 'scheduled' | 'sending' = 'scheduled',
    options: {
        messageText?: string;
        recipients?: { id: string; contact_id: string; contacts: { psid: string; name?: string } }[];
        remainingPendingCount?: number;
        incompleteAudience?: boolean;
        legacyAudience?: boolean;
        serverUpdatedAt?: string;
        templateMediaHeader?: { type: 'image'; url: string };
        stopAfterFirstBatch?: boolean;
        nextAttemptAt?: string;
        deliveryBusy?: boolean;
        deliveryBatchSize?: number;
        deliveryIntervalMs?: number;
        deliveryGrowthAfter?: string;
        claimError?: unknown;
        claimStalls?: boolean;
        progressStallsOnce?: boolean;
        updateError?: { code?: string; message: string };
        backgroundDeliveryEnabled?: boolean;
    } = {}
) {
    const campaignRecord = {
        id: 'campaign_1',
        page_id: 'page_1',
        status: campaignStatus,
        background_delivery_enabled: options.backgroundDeliveryEnabled ?? true,
        updated_at: '2026-11-08T00:00:00.000Z',
        message_text: options.messageText || 'Hello there',
        use_ai_message: false,
        is_loop: false,
        recurrence: 'none',
        audience_mode: 'specific',
        audience_materialized_at: options.incompleteAudience || options.legacyAudience ? null : '2026-08-12T00:00:00.000Z',
        template_media_header: options.templateMediaHeader || null,
        ai_prompt: null,
        next_attempt_at: options.nextAttemptAt || null,
        total_recipients:
            (options.recipients?.length || 0) +
            (options.remainingPendingCount || 0) +
            (options.incompleteAudience ? 1 : 0),
        pages: {
            fb_page_id: 'fb_page_1',
            access_token: 'page_token',
            id: 'page_1'
        }
    };

    const campaignSingle = vi.fn().mockImplementation(async () => ({
        data: { ...campaignRecord },
        error: null
    }));
    const campaignEqId = vi.fn().mockReturnValue({ single: campaignSingle });
    const campaignSelect = vi.fn().mockReturnValue({ eq: campaignEqId });

    const campaignUpdateEq = vi.fn();
    const campaignUpdateIn = vi.fn();
    const campaignUpdate = vi.fn().mockImplementation((updates: Record<string, unknown>) => {
        const matches: Array<() => boolean> = [];
        const query: any = {
            eq: vi.fn((key: keyof typeof campaignRecord, value: unknown) => {
                const args = [key, value];
                campaignUpdateEq(...args);
                matches.push(() => campaignRecord[key] === value);
                return query;
            }),
            in: vi.fn((key: keyof typeof campaignRecord, values: unknown[]) => {
                const args = [key, values];
                campaignUpdateIn(...args);
                matches.push(() => values.includes(campaignRecord[key]));
                return query;
            }),
            select: vi.fn(() => query),
            then: (resolve: (value: unknown) => unknown) => {
                const matched = matches.every(match => match());
                if (matched && !options.updateError) Object.assign(campaignRecord, updates);
                if (matched && !options.updateError && options.serverUpdatedAt) campaignRecord.updated_at = options.serverUpdatedAt;
                return Promise.resolve({ data: matched ? [{ id: campaignRecord.id, updated_at: campaignRecord.updated_at }] : [], error: options.updateError || null }).then(resolve);
            }
        };
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
    const claimedRecipients = new Map<string, typeof pendingRecipients[number]>();
    const fixedRemaining = options.remainingPendingCount || 0;
    const claimRpc = vi.fn();
    const finishBatchRpc = vi.fn();
    let stallProgress = options.progressStallsOnce;
    const rpc = vi.fn(async (name: string, args: Record<string, any>) => {
        if (name === 'acquire_page_campaign_delivery') return { data: [{ acquired: !options.deliveryBusy, retry_at: options.deliveryBusy ? '2026-10-13T00:01:00Z' : null, batch_size: options.deliveryBatchSize || 10 }], error: null };
        if (name === 'release_page_campaign_delivery') return { data: null, error: null };
        if (name === 'report_page_campaign_delivery_feedback') return { data: { owned: true,
            concurrency: args.p_concurrency ?? options.deliveryBatchSize ?? 10,
            interval_ms: args.p_interval_ms ?? options.deliveryIntervalMs ?? 0, retry_at: null,
            growth_after: options.deliveryGrowthAfter || null }, error: null };
        if (name === 'claim_campaign_recipients') {
            claimRpc(args);
            if (options.claimStalls) return new Promise<never>(() => {});
            if (options.claimError) return { data: null, error: options.claimError };
            const recipients = pendingRecipients.splice(0, args.p_batch_size);
            for (const recipient of recipients) claimedRecipients.set(recipient.contact_id, recipient);
            const claimed = recipients.map(recipient => ({
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
                claimedRecipients.delete(result.contact_id);
                if (result.success) sentCount += 1;
                else failedCount += 1;
            }
            if (options.stopAfterFirstBatch) campaignRecord.status = 'draft';
            return { data: args.p_results.length, error: null };
        }

        if (name === 'get_campaign_delivery_progress') {
            if (stallProgress) { stallProgress = false; return new Promise<never>(() => {}); }
            return {
                data: [{
                    sent_count: sentCount,
                    failed_count: failedCount,
                    remaining_count: pendingRecipients.length + fixedRemaining + claimedRecipients.size
                }],
                error: null
            };
        }

        throw new Error(`Unexpected RPC: ${name}`);
    });

    const releaseBatchUpdate = vi.fn();
    const campaignRecipientsUpdate = vi.fn(() => {
        const query: any = {
            eq: vi.fn(() => query),
            in: vi.fn((_column: string, contactIds: string[]) => {
                for (const id of contactIds) {
                    const recipient = claimedRecipients.get(id);
                    if (recipient) pendingRecipients.push(recipient);
                    claimedRecipients.delete(id);
                }
                releaseBatchUpdate(contactIds);
                return Promise.resolve({ error: null });
            })
        };
        return query;
    });

    const outboundUpsert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn((table: string) => {
        if (table === 'outbound_message_events') return { upsert: outboundUpsert };
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
                update: campaignRecipientsUpdate
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        rpc,
        campaignUpdate,
        campaignUpdateEq,
        campaignUpdateIn,
        claimRpc,
        finishBatchRpc,
        releaseBatchUpdate,
        outboundUpsert,
        campaignSingle,
        campaignRecord,
        userPageSingle
    };
}

describe('sendCampaignById', () => {
    afterEach(() => { vi.useRealTimers(); });
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(waitForPageDeliveryBatch).mockResolvedValue(undefined);
        vi.mocked(takeThreadControl).mockResolvedValue(undefined);
        vi.mocked(getPageTemplates).mockResolvedValue([
            { name: 'general_msg_v1', language: 'en_US', status: 'APPROVED' },
            { name: 'general_notice_v1', language: 'en_US', status: 'APPROVED' },
            { name: 'general_msg_v1_media_v1', language: 'en_US', status: 'APPROVED' },
            { name: 'general_notice_v1_media_v1', language: 'en_US', status: 'APPROVED' }
        ]);
    });

    it('does not restart a stopped draft when a lost first response is retried', async () => {
        const supabase = createSupabaseMock('draft');
        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never,
            expectedUpdatedAt: '2026-11-07T00:00:00.000Z' });
        expect(result.body).toMatchObject({ paused: true, retryable: false });
        expect(supabase.campaignUpdate).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('returns completion when a background worker finishes before the browser retry', async () => {
        const supabase = createSupabaseMock('sending');
        Object.assign(supabase.campaignRecord, { status: 'completed', sent_count: 3, failed_count: 1 });
        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never, backgroundOnly: true });
        expect(result.body).toMatchObject({ success: true, sent: 3, failed: 1, remaining: 0 });
        expect(supabase.campaignUpdate).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it.each([false, true])('retries a stale activation after another worker saves progress (Page busy: %s)', async busy => {
        const settings = { deliveryBusy: busy, recipients: [
            { id: 'done', contact_id: 'done', contacts: { psid: 'already-delivered' } },
            { id: 'pending', contact_id: 'pending', contacts: { psid: 'still-pending' } }
        ] };
        const supabase = createSupabaseMock('sending', settings);
        const rpc = supabase.rpc.getMockImplementation()!;
        let advanced = false;
        supabase.rpc.mockImplementation(async (name, args) => {
            if (name === 'acquire_page_campaign_delivery' && !advanced) {
                advanced = true;
                // Another worker completes a recipient after this request's
                // campaign read and before its conditional activation write.
                await rpc('claim_campaign_recipients', { p_batch_size: 1 });
                await rpc('finish_campaign_recipient_batch', {
                    p_results: [{ contact_id: 'done', success: true }]
                });
                Object.assign(supabase.campaignRecord, {
                    sent_count: 1, updated_at: '2026-11-09T00:00:01.000Z'
                });
            }
            return rpc(name, args);
        });
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'accepted-pending' });
        const options = { campaignId: 'campaign_1', supabase: supabase as never, backgroundOnly: true };

        const deferred = await sendCampaignById(options);

        expect(deferred.body).toMatchObject({ partial: true, queued: true, retryable: true,
            sent: 1, failed: 0, remaining: 1 });
        expect(deferred.body.paused).not.toBe(true);
        expect(supabase.campaignRecord.status).toBe('sending');
        expect(sendMessage).not.toHaveBeenCalled();

        settings.deliveryBusy = false;
        const resumed = await sendCampaignById(options);

        expect(resumed.body).toMatchObject({ success: true, sent: 2, failed: 0 });
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(vi.mocked(sendMessage).mock.calls[0][2]).toBe('still-pending');
        expect(supabase.campaignRecord.status).toBe('completed');
    });

    it.each(['draft', 'cancelled'])('honors a concurrent %s instead of rearming it after an activation conflict', async status => {
        const supabase = createSupabaseMock('sending', { remainingPendingCount: 200 });
        const rpc = supabase.rpc.getMockImplementation()!;
        supabase.rpc.mockImplementation(async (name, args) => {
            if (name === 'acquire_page_campaign_delivery') {
                Object.assign(supabase.campaignRecord, { status, background_delivery_enabled: false,
                    updated_at: '2026-11-09T00:00:01.000Z' });
            }
            return rpc(name, args);
        });

        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never, backgroundOnly: true });

        expect(result.body).toMatchObject({ paused: true, queued: false, retryable: false,
            cancelled: status === 'cancelled', remaining: 200 });
        expect(supabase.campaignRecord).toMatchObject({ status, background_delivery_enabled: false });
        expect(supabase.claimRpc).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('reports fresh completion when another worker finishes during Page acquisition', async () => {
        const supabase = createSupabaseMock('sending', { remainingPendingCount: 200 });
        const rpc = supabase.rpc.getMockImplementation()!;
        supabase.rpc.mockImplementation(async (name, args) => {
            if (name === 'acquire_page_campaign_delivery') {
                Object.assign(supabase.campaignRecord, { status: 'completed', sent_count: 190, failed_count: 10,
                    updated_at: '2026-11-09T00:00:01.000Z' });
            }
            return rpc(name, args);
        });

        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never, backgroundOnly: true });

        expect(result.body).toEqual({ success: true, sent: 190, failed: 10, remaining: 0 });
        expect(supabase.campaignRecord.status).toBe('completed');
        expect(supabase.claimRpc).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('leaves persistence time before starting another slow batch and resumes the rest later', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('draft', { recipients: [
            { id: 'one', contact_id: 'one', contacts: { psid: 'one' } },
            { id: 'two', contact_id: 'two', contacts: { psid: 'two' } }
        ] });
        vi.mocked(sendMessage).mockImplementationOnce(() => new Promise(resolve => {
            setTimeout(() => resolve({ message_id: 'accepted-one' }), 25_000);
        })).mockResolvedValue({ message_id: 'accepted-two' });
        const options = { campaignId: 'campaign_1', supabase: supabase as never, sendBatchSize: 1, maxProcessingTimeMs: 45_000 };
        const pending = sendCampaignById(options);
        await vi.advanceTimersByTimeAsync(25_000);
        expect((await pending).body).toMatchObject({ partial: true, sent: 1, remaining: 1 });
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect((await sendCampaignById({ ...options, backgroundOnly: true })).body).toMatchObject({ sent: 2, failed: 0 });
        expect(vi.mocked(sendMessage).mock.calls.map(call => call[2])).toEqual(['one', 'two']);
    });

    it('yields a paced claim at the deadline without adding a service-error cooldown', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('sending', {
            deliveryBatchSize: 5, deliveryIntervalMs: 2000,
            recipients: Array.from({ length: 10 }, (_, index) => ({
                id: `r${index}`, contact_id: `c${index}`, contacts: { psid: `p${index}` }
            }))
        });
        vi.mocked(sendMessage).mockImplementation(async (_page, _token, psid) => {
            await new Promise(resolve => setTimeout(resolve, 100));
            return { message_id: `accepted-${psid}` };
        });
        const options = { campaignId: 'campaign_1', supabase: supabase as never, backgroundOnly: true };
        const first = sendCampaignById({ ...options, maxProcessingTimeMs: 10_000 });
        await vi.runAllTimersAsync();
        const yielded = await first;

        expect(yielded.status).toBe(200);
        expect(yielded.body).toMatchObject({ success: true, partial: true, sent: 1, failed: 0, remaining: 9 });
        expect(yielded.body.paused).not.toBe(true);
        expect(supabase.campaignRecord.next_attempt_at).toBeNull();

        const next = sendCampaignById({ ...options, maxProcessingTimeMs: 45_000 });
        await vi.runAllTimersAsync();
        expect((await next).body).toMatchObject({ success: true, sent: 10, failed: 0 });
        expect(sendMessage).toHaveBeenCalledTimes(10);
        expect(new Set(vi.mocked(sendMessage).mock.calls.map(call => call[2])).size).toBe(10);
    });

    it('finishes a started multipart recipient across the soft deadline without replaying its first message', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('sending', {
            deliveryBatchSize: 1, deliveryIntervalMs: 1000,
            messageText: serializeCampaignMessageSequence(['First', 'Second']),
            recipients: ['one', 'two'].map(id => ({ id, contact_id: id, contacts: { psid: id } }))
        });
        vi.mocked(sendMessage).mockImplementation(async (_page, _token, psid, text) => {
            await new Promise(resolve => setTimeout(resolve, psid === 'one' && text === 'First' ? 2500 : 100));
            return { message_id: `${psid}-${text}` };
        });
        const options = { campaignId: 'campaign_1', supabase: supabase as never, backgroundOnly: true };
        const first = sendCampaignById({ ...options, maxProcessingTimeMs: 10_000 });
        await vi.runAllTimersAsync();
        expect((await first).body).toMatchObject({ success: true, partial: true, sent: 1, failed: 0, remaining: 1 });
        expect(supabase.campaignRecord.next_attempt_at).toBeNull();

        const second = sendCampaignById({ ...options, maxProcessingTimeMs: 45_000 });
        await vi.runAllTimersAsync();
        expect((await second).body).toMatchObject({ success: true, sent: 2, failed: 0 });
        expect(vi.mocked(sendMessage).mock.calls.map(call => [call[2], call[3]])).toEqual([
            ['one', 'First'], ['one', 'Second'], ['two', 'First'], ['two', 'Second']
        ]);
    });

    it('does not mutate or send a campaign if the membership service is unavailable', async () => {
        const supabase = createSupabaseMock('draft');
        supabase.userPageSingle.mockResolvedValueOnce({ data: null, error: { code: '08000', message: 'Connection failed' } });
        const result = await sendCampaignById({ campaignId: 'campaign_1', userId: 'user_1', supabase: supabase as never });
        expect(result.status).toBe(503);
        expect(supabase.campaignUpdate).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('bounds a stalled campaign lookup without changing a campaign before authorization', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('draft');
        supabase.campaignSingle.mockImplementationOnce(() => new Promise(() => {}));
        const pending = sendCampaignById({ campaignId: 'campaign_1', userId: 'user_1', supabase: supabase as never });
        await vi.advanceTimersByTimeAsync(DATABASE_REQUEST_TIMEOUT_MS);
        expect((await pending).status).toBe(503);
        expect(supabase.campaignUpdate).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps a stalled recipient claim resumable instead of exhausting the function timeout', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('draft', { claimStalls: true });
        const pending = sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });
        await vi.advanceTimersByTimeAsync(DATABASE_REQUEST_TIMEOUT_MS);
        const result = await pending;
        expect(result.status).toBe(503);
        expect(result.body.retryable).toBe(true);
        expect(supabase.campaignUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'sending', background_delivery_enabled: true }));
        expect(sendMessage).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not send if the database rejects the sending-state update', async () => {
        const supabase = createSupabaseMock('draft', { updateError: { code: '08000', message: 'Connection failed' } });
        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });
        expect(result.status).toBe(503);
        expect(supabase.claimRpc).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('persists accepted sends before a stalled optional audit write', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('draft', { recipients: [{ id: 'recipient', contact_id: 'contact', contacts: { psid: 'psid' } }] });
        supabase.outboundUpsert.mockImplementationOnce(() => new Promise(() => {}));
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'mid_saved' });
        const pending = sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });
        await vi.advanceTimersByTimeAsync(DATABASE_REQUEST_TIMEOUT_MS + 1000);
        const result = await pending;
        expect(result.status).toBe(200);
        expect(result.sent).toBe(1);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(supabase.finishBatchRpc.mock.invocationCallOrder[0]).toBeLessThan(supabase.outboundUpsert.mock.invocationCallOrder[0]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('resumes after a stalled progress read without resending persisted results', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('draft', { progressStallsOnce: true,
            recipients: [{ id: 'recipient', contact_id: 'contact', contacts: { psid: 'psid' } }] });
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'mid_saved' });
        const pending = sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });
        await vi.advanceTimersByTimeAsync(DATABASE_REQUEST_TIMEOUT_MS);
        expect((await pending).status).toBe(503);
        await vi.advanceTimersByTimeAsync(60_000);
        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });
        expect(result.status).toBe(200);
        expect(result.sent).toBe(1);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('drains a large audience through repeated bounded invocations without duplicates', async () => {
        const recipients = Array.from({ length: 5001 }, (_, index) => ({ id: `recipient_${index}`, contact_id: `contact_${index}`, contacts: { psid: `psid_${index}` } }));
        const supabase = createSupabaseMock('draft', { recipients });
        vi.mocked(sendMessage).mockImplementation(async (_page, _token, psid) => ({ message_id: `mid_${psid}` }));
        let result;
        for (let run = 0; run < 11; run++) {
            result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never, maxRecipientsPerRun: 500 });
            expect(result.status).toBe(200);
            expect(result.body.partial).toBe(run < 10 ? true : undefined);
        }
        expect(result?.sent).toBe(5001);
        expect(sendMessage).toHaveBeenCalledTimes(5001);
        expect(new Set(vi.mocked(sendMessage).mock.calls.map(call => call[2])).size).toBe(5001);
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

    it('does not claim or send recipients before the queued retry time', async () => {
        const nextAttemptAt = new Date(Date.now() + 60000).toISOString();
        const supabase = createSupabaseMock('draft', { nextAttemptAt, remainingPendingCount: 10 });

        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });

        expect(result.status).toBe(503);
        expect(result.body).toEqual(expect.objectContaining({
            paused: true, retryable: true, nextAttemptAt, remaining: 10
        }));
        expect(supabase.claimRpc).not.toHaveBeenCalled();
        expect(supabase.campaignUpdate).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('records message attribution once per recipient batch', async () => {
        const recipients = Array.from({ length: 3 }, (_, index) => ({
            id: `recipient_${index}`, contact_id: `contact_${index}`,
            contacts: { psid: `psid_${index}`, name: 'Alex' }
        }));
        const supabase = createSupabaseMock('draft', { recipients });
        vi.mocked(sendMessage).mockImplementation(async (_pageId, _token, psid) => ({ message_id: `mid_${psid}` }));

        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });

        expect(result.sent).toBe(3);
        expect(supabase.outboundUpsert).toHaveBeenCalledTimes(1);
        expect(supabase.outboundUpsert.mock.calls[0][0]).toHaveLength(3);
        expect(supabase.outboundUpsert.mock.calls[0][0].map((event: any) => event.contact_id)).toEqual([
            'contact_0', 'contact_1', 'contact_2'
        ]);
    });

    it('leaves recipients untouched when another campaign owns this Page', async () => {
        const supabase = createSupabaseMock('draft', { deliveryBusy: true, remainingPendingCount: 200 });
        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ queued: true, remaining: 200, processed: 0 });
        expect(supabase.claimRpc).not.toHaveBeenCalled();
        expect(supabase.campaignUpdate).toHaveBeenCalledWith(expect.objectContaining({
            status: 'sending', background_delivery_enabled: true,
            next_attempt_at: '2026-10-13T00:01:00Z'
        }));
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('preserves due-only delivery when a scheduled campaign waits for the Page', async () => {
        const supabase = createSupabaseMock('scheduled', { deliveryBusy: true, remainingPendingCount: 200 });
        await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never,
            allowScheduled: true, dueAt: '2026-10-26T08:00:00Z' });
        expect(supabase.campaignUpdate).toHaveBeenCalledWith(expect.objectContaining({
            status: 'scheduled', background_delivery_enabled: false
        }));
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('paces a recovering Page even when the caller requests no delay', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('draft', {
            deliveryBatchSize: 1,
            deliveryIntervalMs: 2000,
            messageText: serializeCampaignMessageSequence(['First', 'Second']),
            recipients: [1, 2].map(id => ({ id: `r${id}`, contact_id: `c${id}`, contacts: { psid: `p${id}` } }))
        });
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'mid_recovery' });
        const started = Date.now();
        const times: number[] = [];
        vi.mocked(sendMessage).mockImplementation(async () => { times.push(Date.now() - started); return { message_id: 'accepted' }; });
        const pending = sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never,
            delayBetweenBatchesMs: 0 });
        await vi.runAllTimersAsync();
        const result = await pending;
        expect(result.sent).toBe(2);
        expect(supabase.claimRpc).toHaveBeenCalledWith(expect.objectContaining({ p_batch_size: 5 }));
        expect(times).toEqual([0, 2000, 4000, 6000]);
    });

    it('prefetches a slow single-worker queue without changing message spacing or replaying recipients', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('sending', {
            deliveryBatchSize: 1, deliveryIntervalMs: 1000,
            deliveryGrowthAfter: new Date(Date.now() + 600_000).toISOString(),
            recipients: Array.from({ length: 30 }, (_, i) => ({
                id: `r${i}`, contact_id: `c${i}`, contacts: { psid: `p${i}` }
            }))
        });
        const starts: number[] = [];
        vi.mocked(sendMessage).mockImplementation(async () => {
            starts.push(Date.now()); return { message_id: 'accepted' };
        });
        const pending = sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never,
            backgroundOnly: true, maxProcessingTimeMs: 45_000 });
        await vi.runAllTimersAsync();
        expect((await pending).body).toMatchObject({ success: true, sent: 30 });
        expect(supabase.claimRpc.mock.calls[0][0].p_batch_size).toBe(5);
        expect(supabase.claimRpc.mock.calls.length).toBeLessThanOrEqual(7);
        expect(starts.slice(1).every((time, i) => time - starts[i] >= 1000)).toBe(true);
        expect(new Set(vi.mocked(sendMessage).mock.calls.map(call => call[2])).size).toBe(30);
    });

    it('checks Stop during a slow prefetch instead of waiting for 50 receipts', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('sending', {
            deliveryBatchSize: 1, deliveryIntervalMs: 5000, stopAfterFirstBatch: true,
            deliveryGrowthAfter: new Date(Date.now() + 600_000).toISOString(),
            recipients: Array.from({ length: 10 }, (_, i) => ({
                id: `r${i}`, contact_id: `c${i}`, contacts: { psid: `p${i}` }
            }))
        });
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'accepted' });
        const pending = sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never, backgroundOnly: true });
        await vi.runAllTimersAsync();
        expect((await pending).body).toMatchObject({ paused: true, retryable: false });
        expect(sendMessage).toHaveBeenCalledTimes(2);
        expect(supabase.releaseBatchUpdate).toHaveBeenCalled();
        expect(supabase.campaignRecord.status).toBe('draft');
    });

    it('does not ramp a recovering Page back into a burst across consecutive sender slices', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('sending', {
            deliveryBatchSize: 1, deliveryIntervalMs: 5000,
            deliveryGrowthAfter: new Date(Date.now() + 10 * 60_000).toISOString(),
            recipients: Array.from({ length: 50 }, (_, index) => ({
                id: `r${index}`, contact_id: `c${index}`, contacts: { psid: `p${index}` }
            }))
        });
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'accepted', deliveryFeedback: { usagePercent: 5 } });
        for (let run = 0; run < 2; run++) {
            const pending = sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never,
                backgroundOnly: true, maxRecipientsPerRun: 25 });
            await vi.runAllTimersAsync();
            expect((await pending).sent).toBe((run + 1) * 25);
        }
        const saved = supabase.rpc.mock.calls.filter(([name, args]) =>
            name === 'report_page_campaign_delivery_feedback' && args.p_concurrency != null);
        expect(saved.length).toBeGreaterThan(0);
        for (const [, args] of saved) expect(args).toMatchObject({ p_concurrency: 1, p_interval_ms: 5000 });
        expect(new Set(vi.mocked(sendMessage).mock.calls.map(call => call[2])).size).toBe(50);
    });

    it('ramps a healthy Page within its shared budget without artificial waits', async () => {
        const supabase = createSupabaseMock('draft', { deliveryBatchSize: 100, recipients:
            Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}`, contact_id: `c${i}`, contacts: { psid: `p${i}` } }))
        });
        vi.mocked(sendMessage).mockImplementation(async (_page, _token, psid) => ({ message_id: `mid_${psid}` }));
        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });
        expect(result.sent).toBe(1000);
        expect(supabase.claimRpc.mock.calls[0][0].p_batch_size).toBe(500);
        expect(supabase.claimRpc.mock.calls.every(([args]) => args.p_batch_size <= 500)).toBe(true);
        expect(waitForPageDeliveryBatch).not.toHaveBeenCalled();
        expect(supabase.outboundUpsert).toHaveBeenCalledTimes(4);
        expect(supabase.outboundUpsert.mock.calls.flatMap(([events]) => events)).toHaveLength(1000);
        expect(new Set(vi.mocked(sendMessage).mock.calls.map(call => call[2])).size).toBe(1000);
    });

    it('stops growing immediately when Meta throttles an aggressive Page', async () => {
        const supabase = createSupabaseMock('draft', { deliveryBatchSize: 25, recipients:
            Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, contact_id: `c${i}`, contacts: { psid: `p${i}` } }))
        });
        vi.mocked(sendMessage).mockImplementation(async (_page, _token, psid) => {
            if (psid === 'p10') throw new Error('(#613) Rate limit reached');
            return { message_id: `mid_${psid}` };
        });
        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });
        const accepted = vi.mocked(sendMessage).mock.calls.filter(call => call[2] !== 'p10').length;
        expect(result.body).toMatchObject({ retryable: true, remaining: 100 - accepted, sent: accepted, failed: 0 });
        expect(vi.mocked(sendMessage).mock.calls.length).toBeLessThanOrEqual(50);
        expect(supabase.claimRpc.mock.calls.map(([args]) => args.p_batch_size)).toEqual([125]);
        expect(supabase.outboundUpsert.mock.calls.flatMap(([events]) => events)).toHaveLength(accepted);
        expect(supabase.campaignRecord.background_delivery_enabled).toBe(true);
    });

    it('uses Meta Retry-After and saves reduced capacity across workers', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('draft', { deliveryBatchSize: 20, recipients: [
            { id: 'r', contact_id: 'c', contacts: { psid: 'psid' } }
        ] });
        vi.mocked(sendMessage).mockRejectedValueOnce(Object.assign(new Error('Application rate limit reached'), {
            status: 429, code: 4, retryAfterMs: 120_000
        }));
        const started = Date.now();
        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });
        expect(result.body).toMatchObject({ retryable: true, remaining: 1, failed: 0 });
        expect(Date.parse(String(result.body.nextAttemptAt)) - started).toBe(120_000);
        const feedback = supabase.rpc.mock.calls.find(([name, args]) => name === 'report_page_campaign_delivery_feedback' && args.p_rate_limited);
        expect(feedback?.[1]).toMatchObject({ p_concurrency: 10, p_interval_ms: 100, p_scope: 'app', p_retry_after_ms: 120_000 });
        expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it('reduces the learned budget when successful replies report rising quota usage', async () => {
        const supabase = createSupabaseMock('draft', { deliveryBatchSize: 20, recipients: [
            { id: 'r', contact_id: 'c', contacts: { psid: 'psid' } }
        ] });
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'accepted', deliveryFeedback: { usagePercent: 95 } });
        expect((await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never })).body.success).toBe(true);
        expect(supabase.rpc).toHaveBeenCalledWith('report_page_campaign_delivery_feedback', expect.objectContaining({
            p_concurrency: 10, p_interval_ms: 50, p_rate_limited: false
        }));
    });

    it('checkpoints fast recipients while a slow recipient still occupies another slot', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('draft', { deliveryBatchSize: 100, recipients:
            Array.from({ length: 125 }, (_, i) => ({ id: `r${i}`, contact_id: `c${i}`, contacts: { psid: `p${i}` } }))
        });
        vi.mocked(sendMessage).mockImplementation(async (_page, _token, psid) => {
            await new Promise(resolve => setTimeout(resolve, psid === 'p0' ? 10_000 : 100));
            return { message_id: `mid_${psid}` };
        });
        const pending = sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });
        await vi.advanceTimersByTimeAsync(1000);
        expect(sendMessage).toHaveBeenCalledTimes(125);
        expect(supabase.finishBatchRpc.mock.calls.flatMap(([args]) => args.p_results)).toHaveLength(100);
        expect(supabase.finishBatchRpc.mock.calls.flatMap(([args]) => args.p_results).some(result => result.contact_id === 'c0')).toBe(false);
        await vi.runAllTimersAsync();
        expect((await pending).body).toMatchObject({ success: true, sent: 125, failed: 0 });
        expect(new Set(supabase.finishBatchRpc.mock.calls.flatMap(([args]) => args.p_results.map((result: any) => result.contact_id))).size).toBe(125);
    });

    it('honors Stop at a checkpoint and releases unstarted recipients from a large claim', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('draft', { deliveryBatchSize: 100, stopAfterFirstBatch: true, recipients:
            Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, contact_id: `c${i}`, contacts: { psid: `p${i}` } }))
        });
        vi.mocked(sendMessage).mockImplementation(async (_page, _token, psid) => {
            await new Promise(resolve => setTimeout(resolve, 100));
            return { message_id: `mid_${psid}` };
        });
        const pending = sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });
        await vi.runAllTimersAsync();
        expect((await pending).body.paused).toBe(true);
        expect(supabase.campaignRecord.status).toBe('draft');
        expect(vi.mocked(sendMessage).mock.calls.length).toBeLessThan(200);
        expect(supabase.releaseBatchUpdate).toHaveBeenCalled();
        expect(supabase.claimRpc).toHaveBeenCalledTimes(1);
    });

    it('benchmarks prior pacing against aggressive delivery with simulated network latency', async () => {
        vi.useFakeTimers();
        const metrics: Array<{ mode: string; elapsedMs: number; auditWrites: number; maxInFlight: number }> = [];
        for (const settings of [
            { mode: 'prior pacing', pageSize: 5, delay: 1000, fetchedBatchSize: 5 },
            { mode: 'small fetches at five workers', pageSize: 5, delay: 0, fetchedBatchSize: 5 },
            { mode: 'prefetched five workers', pageSize: 5, delay: 0, fetchedBatchSize: Infinity },
            { mode: '25 rolling workers', pageSize: 25, delay: 0, fetchedBatchSize: Infinity },
            { mode: '100 rolling workers', pageSize: 100, delay: 0, fetchedBatchSize: Infinity }
        ]) {
            vi.setSystemTime(new Date('2026-11-08T00:00:00Z'));
            const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
            const supabase = createSupabaseMock('draft', { deliveryBatchSize: settings.pageSize, recipients:
                Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}`, contact_id: `c${i}`, contacts: { psid: `p${i}` } }))
            });
            const rpc = supabase.rpc.getMockImplementation()!;
            supabase.rpc.mockImplementation(async (name, args) => {
                await wait(20);
                return rpc(name, name === 'claim_campaign_recipients'
                    ? { ...args, p_batch_size: Math.min(args.p_batch_size, settings.fetchedBatchSize) }
                    : args);
            });
            const read = supabase.campaignSingle.getMockImplementation()!;
            supabase.campaignSingle.mockImplementation(async () => { await wait(20); return read(); });
            supabase.outboundUpsert.mockImplementation(async () => { await wait(20); return { error: null }; });
            let inFlight = 0, maxInFlight = 0;
            vi.mocked(sendMessage).mockImplementation(async (_page, _token, psid) => {
                maxInFlight = Math.max(maxInFlight, ++inFlight);
                await wait(200); inFlight--;
                return { message_id: `mid_${psid}` };
            });
            vi.mocked(waitForPageDeliveryBatch).mockImplementation(wait);
            const started = Date.now();
            const pending = sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never,
                sendBatchSize: settings.pageSize,
                maxProcessingTimeMs: 270_000, maxRecipientsPerRun: 1000, delayBetweenBatchesMs: settings.delay });
            await vi.runAllTimersAsync();
            expect((await pending).sent).toBe(1000);
            expect(maxInFlight).toBeLessThanOrEqual(settings.pageSize);
            metrics.push({ mode: settings.mode, elapsedMs: Date.now() - started,
                auditWrites: supabase.outboundUpsert.mock.calls.length, maxInFlight });
        }
        expect(metrics[1].elapsedMs).toBeLessThan(metrics[0].elapsedMs / 3);
        expect(metrics[2].elapsedMs).toBeLessThan(metrics[1].elapsedMs * 0.9);
        expect(metrics[3].elapsedMs).toBeLessThan(metrics[0].elapsedMs / 10);
        console.info('Synthetic sender benchmark (200ms Meta latency, 20ms database latency; no real sends):', JSON.stringify(metrics));
    });

    it('reduces slow-database waits without exceeding a recovering Page message rate', async () => {
        vi.useFakeTimers();
        const metrics: Array<{ prefetch: boolean; elapsedMs: number; claims: number }> = [];
        for (const prefetch of [false, true]) {
            const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
            const supabase = createSupabaseMock('sending', {
                deliveryBatchSize: 1, deliveryIntervalMs: 5000,
                deliveryGrowthAfter: new Date(Date.now() + 3_600_000).toISOString(),
                recipients: Array.from({ length: 20 }, (_, i) => ({
                    id: `r${i}`, contact_id: `c${i}`, contacts: { psid: `p${i}` }
                }))
            });
            const rpc = supabase.rpc.getMockImplementation()!;
            supabase.rpc.mockImplementation(async (name, args) => { await wait(2000); return rpc(name, args); });
            const read = supabase.campaignSingle.getMockImplementation()!;
            supabase.campaignSingle.mockImplementation(async () => { await wait(2000); return read(); });
            const starts: number[] = [];
            vi.mocked(sendMessage).mockImplementation(async () => {
                starts.push(Date.now()); await wait(200); return { message_id: 'accepted' };
            });
            const started = Date.now();
            const pending = sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never,
                backgroundOnly: true, sendBatchSize: prefetch ? 100 : 1, maxRecipientsPerRun: 20 });
            await vi.runAllTimersAsync();
            expect((await pending).body).toMatchObject({ success: true, sent: 20 });
            expect(starts.slice(1).every((time, i) => time - starts[i] >= 5000)).toBe(true);
            metrics.push({ prefetch, elapsedMs: Date.now() - started, claims: supabase.claimRpc.mock.calls.length });
        }
        expect(metrics[1].claims).toBe(metrics[0].claims / 5);
        expect(metrics[1].elapsedMs).toBeLessThan(metrics[0].elapsedMs);
        console.info('Recovery benchmark (2s database latency, 5s message spacing; no real sends):', JSON.stringify(metrics));
    });

    it('blocks an incompletely materialized campaign before any recipient is sent', async () => {
        const supabase = createSupabaseMock('draft', {
            incompleteAudience: true,
            recipients: [{
                id: 'recipient_1',
                contact_id: 'contact_1',
                contacts: {
                    psid: 'psid_1',
                    name: 'Alex'
                }
            }]
        });

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never
        });

        expect(result.status).toBe(409);
        expect(result.body.message).toContain('queuing 1 of 2 recipients');
        expect(sendMessage).not.toHaveBeenCalled();
        expect(supabase.claimRpc).not.toHaveBeenCalled();
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

    it('uses the persisted media header when a background worker resumes delivery', async () => {
        const supabase = createSupabaseMock('draft', {
            messageText: serializeCampaignMessageSequence([
                { text: 'Photo update', templateName: 'general_msg_v1_media_v1', templateLanguage: 'en_US' }
            ]),
            templateMediaHeader: { type: 'image', url: 'https://example.com/persisted.jpg' },
            recipients: [{
                id: 'recipient_1',
                contact_id: 'contact_1',
                contacts: { psid: 'psid_1', name: 'Alex' }
            }]
        });
        vi.mocked(getPageTemplates).mockResolvedValue([{
            name: 'general_msg_v1_media_v1',
            language: 'en_US',
            status: 'APPROVED',
            components: [{ type: 'HEADER', format: 'IMAGE' }]
        }]);
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'mid_background' });

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never
        });

        expect(result.status).toBe(200);
        expect(sendMessage).toHaveBeenCalledWith(
            'fb_page_1',
            'page_token',
            'psid_1',
            'Photo update',
            'UTILITY',
            'general_msg_v1_media_v1',
            'en_US',
            ['Photo update'],
            undefined,
            { type: 'image', url: 'https://example.com/persisted.jpg' }
        );
    });

    it('keeps million-recipient progress bounded to the requested worker slice', async () => {
        const recipients = Array.from({ length: 25 }, (_, index) => ({
            id: `recipient_${index + 1}`,
            contact_id: `contact_${index + 1}`,
            contacts: { psid: `psid_${index + 1}`, name: `Contact ${index + 1}` }
        }));
        const supabase = createSupabaseMock('draft', {
            recipients,
            remainingPendingCount: 999_975
        });
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'mid_scale' });

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never,
            sendBatchSize: 10,
            maxRecipientsPerRun: 25,
            maxProcessingTimeMs: 30_000
        });

        expect(result.status).toBe(200);
        expect(result.body).toEqual(expect.objectContaining({
            partial: true,
            processed: 25,
            total: 1_000_000,
            remaining: 999_975
        }));
        expect(sendMessage).toHaveBeenCalledTimes(25);
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

    it('keeps retrying across repeated failed runs and sends completed recipients only once', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('draft', { recipients: [
            { id: 'done', contact_id: 'done', contacts: { psid: 'done' } },
            { id: 'retry', contact_id: 'retry', contacts: { psid: 'retry' } }
        ] });
        let attempts = 0;
        vi.mocked(sendMessage).mockImplementation(async (_page, _token, psid) => {
            if (psid === 'retry' && ++attempts < 9) throw new Error('fetch failed');
            return { message_id: `accepted-${psid}` };
        });
        const options = { campaignId: 'campaign_1', supabase: supabase as never, sendRetryDelayMs: 0 };
        for (let run = 0; run < 2; run++) {
            const result = await sendCampaignById({ ...options, backgroundOnly: run > 0 });
            expect(result.body).toMatchObject({ retryable: true, sent: 1, failed: 0, remaining: 1 });
            expect(supabase.campaignRecord).toMatchObject({ status: 'sending', background_delivery_enabled: true });
            await vi.advanceTimersByTimeAsync(60_000);
        }
        const result = await sendCampaignById({ ...options, backgroundOnly: true });
        expect(result.body).toMatchObject({ success: true, sent: 2, failed: 0 });
        expect(attempts).toBe(9);
        expect(vi.mocked(sendMessage).mock.calls.filter(call => call[2] === 'done')).toHaveLength(1);
        expect(supabase.campaignRecord.status).toBe('completed');
    });

    it('continues after repeated rate-limit cooldowns without immediate rate-limit retries', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('draft', { recipients: [
            { id: 'retry', contact_id: 'retry', contacts: { psid: 'retry' } }
        ] });
        vi.mocked(sendMessage).mockRejectedValueOnce(new Error('(#613) Rate limit'))
            .mockRejectedValueOnce(new Error('(#613) Rate limit'))
            .mockResolvedValue({ message_id: 'accepted' });
        const options = { campaignId: 'campaign_1', supabase: supabase as never, sendRetryDelayMs: 0 };
        for (let run = 0; run < 2; run++) {
            const result = await sendCampaignById({ ...options, backgroundOnly: run > 0 });
            expect(result.body).toMatchObject({ retryable: true, remaining: 1, failed: 0 });
            expect(sendMessage).toHaveBeenCalledTimes(run + 1);
            const held = await sendCampaignById({ ...options, backgroundOnly: true });
            expect(held.body.nextAttemptAt).toBe(result.body.nextAttemptAt);
            expect(sendMessage).toHaveBeenCalledTimes(run + 1);
            await vi.advanceTimersByTimeAsync(Date.parse(String(result.body.nextAttemptAt)) - Date.now());
        }
        const result = await sendCampaignById({ ...options, backgroundOnly: true });
        expect(result.body).toMatchObject({ success: true, sent: 1, failed: 0 });
        expect(sendMessage).toHaveBeenCalledTimes(3);
    });

    it('honors Stop during the retry delay and resumes only when explicitly continued', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('draft', { recipients: [
            { id: 'retry', contact_id: 'retry', contacts: { psid: 'retry' } }
        ] });
        vi.mocked(sendMessage).mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValue({ message_id: 'accepted' });
        const options = { campaignId: 'campaign_1', supabase: supabase as never, sendRetryDelayMs: 500 };
        const pending = sendCampaignById(options);
        await vi.advanceTimersByTimeAsync(0);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        supabase.campaignRecord.status = 'draft';
        supabase.campaignRecord.background_delivery_enabled = false;
        await vi.advanceTimersByTimeAsync(500);
        expect((await pending).body).toMatchObject({ paused: true, retryable: false });
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(supabase.finishBatchRpc).not.toHaveBeenCalled();
        const continued = await sendCampaignById(options);
        expect(continued.body).toMatchObject({ success: true, sent: 1, failed: 0 });
        expect(sendMessage).toHaveBeenCalledTimes(2);
    });

    it('retries saving an accepted delivery three times without sending the message again', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('draft', { recipients: [
            { id: 'r', contact_id: 'c', contacts: { psid: 'psid' } }
        ] });
        const rpc = supabase.rpc.getMockImplementation()!;
        let saves = 0;
        supabase.rpc.mockImplementation(async (name, args) => {
            if (name === 'finish_campaign_recipient_batch' && ++saves < 3) throw new Error('fetch failed');
            return rpc(name, args);
        });
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'accepted' });
        const pending = sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });
        await vi.advanceTimersByTimeAsync(750);
        expect((await pending).body).toMatchObject({ success: true, sent: 1, failed: 0 });
        expect(saves).toBe(3);
        expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it.each(['feedback', 'receipt'])('saves every accepted in-flight delivery when a checkpoint %s write fails', async failedWrite => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('sending', {
            deliveryBatchSize: 100,
            recipients: Array.from({ length: 125 }, (_, i) => ({
                id: `r${i}`, contact_id: `c${i}`, contacts: { psid: `p${i}` }
            }))
        });
        const rpc = supabase.rpc.getMockImplementation()!;
        let failures = 0;
        supabase.rpc.mockImplementation(async (name, args) => {
            const shouldFail = failedWrite === 'feedback'
                ? name === 'report_page_campaign_delivery_feedback' && args.p_concurrency != null && failures < 1
                : name === 'finish_campaign_recipient_batch' && failures < 3;
            if (shouldFail) {
                failures++;
                return { data: null, error: { code: '08000', message: 'Checkpoint service unavailable' } };
            }
            return rpc(name, args);
        });
        vi.mocked(sendMessage).mockImplementation(async (_page, _token, psid) => {
            await new Promise(resolve => setTimeout(resolve, 100));
            return { message_id: `accepted-${psid}` };
        });
        const options = { campaignId: 'campaign_1', supabase: supabase as never, backgroundOnly: true };
        const pending = sendCampaignById(options);
        await vi.runAllTimersAsync();
        expect((await pending).body).toMatchObject({ retryable: true, queued: true });
        const sent = vi.mocked(sendMessage).mock.calls.length;
        const saved = supabase.finishBatchRpc.mock.calls.flatMap(([args]) => args.p_results);
        expect(saved).toHaveLength(sent);
        expect(new Set(saved.map(receipt => receipt.contact_id)).size).toBe(sent);
        await vi.advanceTimersByTimeAsync(60_000);
        const resumed = sendCampaignById(options);
        await vi.runAllTimersAsync();
        expect((await resumed).body).toMatchObject({ success: true, sent: 125 });
        expect(sendMessage).toHaveBeenCalledTimes(125);
    });

    it('defers slow timeouts to a later run instead of spending the slice on immediate retries', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('draft', { recipients: [
            { id: 'r', contact_id: 'c', contacts: { psid: 'psid' } }
        ] });
        vi.mocked(sendMessage).mockImplementationOnce(() => new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('Facebook send timed out')), 20_000);
        })).mockResolvedValue({ message_id: 'accepted' });
        const pending = sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never, maxProcessingTimeMs: 15_000 });
        await vi.advanceTimersByTimeAsync(21_000);
        expect((await pending).body).toMatchObject({ retryable: true, remaining: 1, failed: 0 });
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(supabase.finishBatchRpc).not.toHaveBeenCalled();
    });

    it('keeps a recipient pending when the campaign status check fails before a retry', async () => {
        const supabase = createSupabaseMock('draft', { recipients: [
            { id: 'r', contact_id: 'c', contacts: { psid: 'psid' } }
        ] });
        const read = supabase.campaignSingle.getMockImplementation()!;
        let reads = 0;
        supabase.campaignSingle.mockImplementation(async () => ++reads === 3
            ? { data: null, error: { code: '08006', message: 'Connection failed' } } as any
            : read());
        vi.mocked(sendMessage).mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValue({ message_id: 'accepted' });
        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never, sendRetryDelayMs: 0 });
        expect(result.body).toMatchObject({ retryable: true, failed: 0, remaining: 1 });
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(supabase.finishBatchRpc).not.toHaveBeenCalled();
    });

    it('recovers a lost save response without resending a delivery already committed to the database', async () => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('draft', { recipients: [
            { id: 'r', contact_id: 'c', contacts: { psid: 'psid' } }
        ] });
        const rpc = supabase.rpc.getMockImplementation()!;
        let saves = 0;
        supabase.rpc.mockImplementation(async (name, args) => {
            if (name === 'finish_campaign_recipient_batch') {
                if (++saves === 1) {
                    await rpc(name, args); // Commit succeeded, but its response was lost.
                    throw new Error('fetch failed');
                }
                return { data: null, error: { code: 'P0001', message: 'Recipient claim already completed' } };
            }
            return rpc(name, args);
        });
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'accepted' });
        const options = { campaignId: 'campaign_1', supabase: supabase as never };
        const pending = sendCampaignById(options);
        await vi.advanceTimersByTimeAsync(750);
        expect((await pending).body.retryable).toBe(true);
        expect(saves).toBe(3);
        await vi.advanceTimersByTimeAsync(60_000);
        const resumed = await sendCampaignById({ ...options, backgroundOnly: true });
        expect(resumed.body).toMatchObject({ success: true, sent: 1, failed: 0 });
        expect(supabase.campaignRecord.status).toBe('completed');
        expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it('pauses on a missing template without consuming the remaining audience', async () => {
        const recipients = Array.from({ length: 3 }, (_, index) => ({
            id: `recipient_${index + 1}`,
            contact_id: `contact_${index + 1}`,
            contacts: {
                psid: `psid_${index + 1}`,
                name: `Contact ${index + 1}`
            }
        }));
        const supabase = createSupabaseMock('draft', { recipients });
        vi.mocked(sendMessage).mockRejectedValue(new Error('(#100) Template cannot be found.'));

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never,
            sendBatchSize: 3,
            sendRetryAttempts: 1,
            sendRetryDelayMs: 0
        });

        expect(result.status).toBe(409);
        expect(result.body.paused).toBe(true);
        expect(result.body.retryable).toBe(false);
        expect(result.failed).toBe(0);
        expect(result.body.remaining).toBe(3);
        expect(sendMessage).toHaveBeenCalledTimes(3);
        expect(supabase.finishBatchRpc).not.toHaveBeenCalled();
        expect(supabase.releaseBatchUpdate).toHaveBeenCalledWith([
            'contact_1',
            'contact_2',
            'contact_3'
        ]);
        expect(supabase.campaignUpdate).toHaveBeenLastCalledWith(
            expect.objectContaining({ status: 'draft' })
        );
    });

    it('fails only a deleted conversation and continues sending the campaign', async () => {
        const recipients = Array.from({ length: 2 }, (_, index) => ({
            id: `recipient_${index + 1}`,
            contact_id: `contact_${index + 1}`,
            contacts: { psid: `psid_${index + 1}`, name: `Contact ${index + 1}` }
        }));
        const supabase = createSupabaseMock('draft', { recipients });
        const deletedConversationError = Object.assign(
            new Error('(#100) The thread owner has archived or deleted this conversation, or the thread does not exist.'),
            { status: 400, code: 100, subcode: 2534001 }
        );
        vi.mocked(sendMessage)
            .mockRejectedValueOnce(deletedConversationError)
            .mockResolvedValueOnce({ message_id: 'mid_valid_recipient' });

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never,
            sendBatchSize: 2,
            sendRetryAttempts: 1,
            sendRetryDelayMs: 0
        });

        expect(result.status).toBe(200);
        expect(result.body.paused).toBeUndefined();
        expect(result.sent).toBe(1);
        expect(result.failed).toBe(1);
        expect(sendMessage).toHaveBeenCalledTimes(2);
        expect(supabase.finishBatchRpc).toHaveBeenCalledWith(expect.objectContaining({
            p_results: expect.arrayContaining([
                expect.objectContaining({
                    contact_id: 'contact_1',
                    success: false,
                    error_message: deletedConversationError.message
                }),
                expect.objectContaining({
                    contact_id: 'contact_2',
                    success: true,
                    error_message: null
                })
            ])
        }));
        expect(supabase.releaseBatchUpdate).not.toHaveBeenCalled();
    });

    it('takes thread control and retries when another app controls the thread', async () => {
        const recipients = [{
            id: 'recipient_1',
            contact_id: 'contact_1',
            contacts: { psid: 'psid_1', name: 'Contact 1' }
        }];
        const supabase = createSupabaseMock('draft', { recipients });
        const threadControlError = Object.assign(
            new Error('(#10) Message failed to send because another app is controlling this thread now.'),
            { status: 400, code: 10, subcode: 2018300 }
        );
        vi.mocked(sendMessage)
            .mockRejectedValueOnce(threadControlError)
            .mockResolvedValueOnce({ message_id: 'mid_after_takeover' });

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never,
            sendBatchSize: 1,
            sendRetryAttempts: 0
        });

        expect(result.status).toBe(200);
        expect(result.sent).toBe(1);
        expect(takeThreadControl).toHaveBeenCalledWith(
            'page_token',
            'psid_1',
            'Tokko campaign campaign_1'
        );
        expect(sendMessage).toHaveBeenCalledTimes(2);
    });

    it('fails only controlled threads and continues when automatic takeover fails', async () => {
        const recipients = Array.from({ length: 3 }, (_, index) => ({
            id: `recipient_${index + 1}`,
            contact_id: `contact_${index + 1}`,
            contacts: { psid: `psid_${index + 1}`, name: `Contact ${index + 1}` }
        }));
        const supabase = createSupabaseMock('draft', { recipients });
        const threadControlError = Object.assign(
            new Error('(#10) Message failed to send because another app is controlling this thread now.'),
            { status: 400, code: 10, subcode: 2018300 }
        );
        vi.mocked(sendMessage).mockRejectedValue(threadControlError);
        vi.mocked(takeThreadControl).mockRejectedValue(
            new Error('This app is not the Primary Receiver')
        );

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never,
            sendBatchSize: 3
        });

        expect(result.status).toBe(200);
        expect(result.body.paused).toBeUndefined();
        expect(result.failed).toBe(3);
        expect(takeThreadControl).toHaveBeenCalledTimes(3);
        expect(supabase.finishBatchRpc).toHaveBeenCalledWith(expect.objectContaining({
            p_results: expect.arrayContaining([
                expect.objectContaining({ contact_id: 'contact_1', success: false }),
                expect.objectContaining({ contact_id: 'contact_2', success: false }),
                expect.objectContaining({ contact_id: 'contact_3', success: false })
            ])
        }));
        expect(supabase.releaseBatchUpdate).not.toHaveBeenCalled();
    });

    it('stops before claiming another batch and preserves unsent recipients', async () => {
        const recipients = Array.from({ length: 2 }, (_, index) => ({
            id: `recipient_${index + 1}`,
            contact_id: `contact_${index + 1}`,
            contacts: { psid: `psid_${index + 1}`, name: `Contact ${index + 1}` }
        }));
        const supabase = createSupabaseMock('draft', {
            recipients,
            stopAfterFirstBatch: true
        });
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'mid_sent' });

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never,
            sendBatchSize: 1
        });

        expect(result.status).toBe(200);
        expect(result.body.paused).toBe(true);
        expect(result.body.remaining).toBe(1);
        expect(result.sent).toBe(1);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(supabase.claimRpc).toHaveBeenCalledTimes(1);
    });

    it('preflights templates before claiming recipients', async () => {
        const supabase = createSupabaseMock('draft', {
            messageText: serializeCampaignMessageSequence([
                { text: 'Hello', templateName: 'missing_media_template', templateLanguage: 'en_US' }
            ]),
            recipients: [{
                id: 'recipient_1',
                contact_id: 'contact_1',
                contacts: { psid: 'psid_1', name: 'Alex' }
            }]
        });

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never
        });

        expect(result.status).toBe(409);
        expect(result.body.paused).toBe(true);
        expect(result.body.message).toContain("template 'missing_media_template'");
        expect(supabase.claimRpc).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('preflights utility parameter characters before claiming recipients', async () => {
        const supabase = createSupabaseMock('draft', {
            messageText: serializeCampaignMessageSequence([
                { text: 'Promo #1 💇', templateName: 'general_msg_v1', templateLanguage: 'en_US' }
            ]),
            recipients: [{
                id: 'recipient_1',
                contact_id: 'contact_1',
                contacts: { psid: 'psid_1', name: 'Alex' }
            }]
        });

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never
        });

        expect(result.status).toBe(409);
        expect(result.body.paused).toBe(true);
        expect(result.body.message).toContain('Unsupported utility template parameter');
        expect(supabase.claimRpc).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('immediately defers a rate-limited send without retrying or permanently failing the recipient', async () => {
        const supabase = createSupabaseMock('draft', {
            recipients: [{
                id: 'recipient_1',
                contact_id: 'contact_1',
                contacts: { psid: 'psid_1', name: 'Alex' }
            }]
        });
        vi.mocked(sendMessage).mockRejectedValue(new Error('(#613) Calls to this api have exceeded the rate limit.'));

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never,
            sendRetryAttempts: 1,
            sendRetryDelayMs: 0
        });

        expect(result.status).toBe(503);
        expect(result.body.retryable).toBe(true);
        expect(result.failed).toBe(0);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(supabase.finishBatchRpc).not.toHaveBeenCalled();
        expect(supabase.releaseBatchUpdate).toHaveBeenCalledWith(['contact_1']);
        expect(supabase.rpc).toHaveBeenCalledWith('release_page_campaign_delivery', expect.objectContaining({ p_page_id: 'page_1', p_rate_limited: true }));
        expect(supabase.campaignUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
            status: 'sending',
            next_attempt_at: expect.any(String),
            last_error: expect.stringContaining('rate limit')
        }));
    });

    it('automatically requeues a transient template preflight outage', async () => {
        const supabase = createSupabaseMock('draft', {
            messageText: serializeCampaignMessageSequence([
                { text: 'Hello', templateName: 'general_msg_v1', templateLanguage: 'en_US' }
            ]),
            recipients: [{
                id: 'recipient_1',
                contact_id: 'contact_1',
                contacts: { psid: 'psid_1', name: 'Alex' }
            }]
        });
        vi.mocked(getPageTemplates).mockRejectedValue(new Error('network temporarily unavailable'));

        const result = await sendCampaignById({
            campaignId: 'campaign_1',
            supabase: supabase as never
        });

        expect(result.status).toBe(503);
        expect(result.body.retryable).toBe(true);
        expect(supabase.claimRpc).not.toHaveBeenCalled();
        expect(supabase.campaignUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
            status: 'sending',
            next_attempt_at: expect.any(String)
        }));
        expect(supabase.campaignRecord.status).toBe('sending');
    });

    it.each([
        { code: 'PGRST000', message: 'Database unavailable' },
        { code: 'PGRST001', message: 'Database unavailable' },
        { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' },
        { code: 'PGRST003', message: 'Database unavailable' },
        { message: 'Could not query the database for the schema cache. Retrying.' }
    ])('automatically requeues a temporary database outage: $code $message', async databaseError => {
        const supabase = createSupabaseMock('draft', {
            remainingPendingCount: 275, claimError: databaseError
        });

        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });

        expect(result.status).toBe(503);
        expect(result.body.retryable).toBe(true);
        expect(supabase.campaignUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
            status: 'sending',
            background_delivery_enabled: true,
            next_attempt_at: expect.any(String),
            last_error: databaseError.message
        }));
        expect(sendMessage).not.toHaveBeenCalled();
        expect(supabase.finishBatchRpc).not.toHaveBeenCalled();
    });

    it('keeps a missing database function paused for repair', async () => {
        const databaseError = {
            code: 'PGRST202',
            message: 'Could not find the function public.claim_campaign_recipients in the schema cache'
        };
        const supabase = createSupabaseMock('draft', {
            remainingPendingCount: 275, claimError: databaseError
        });

        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });

        expect(result.status).toBe(500);
        expect(result.body.retryable).toBe(false);
        expect(supabase.campaignUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
            status: 'draft', background_delivery_enabled: false, next_attempt_at: null
        }));
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it.each([
        new Error('Recipient claim expired before completion'),
        new Error('Not every recipient claim was completed'),
        { message: 'upstream request aborted', name: 'AbortError' },
        { status: 502, message: 'Bad Gateway' },
        new Error('Unexpected worker interruption')
    ])('automatically recovers a worker interruption instead of leaving a draft: %j', async claimError => {
        const supabase = createSupabaseMock('draft', { claimError, remainingPendingCount: 275 });
        const before = Date.now();
        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });
        expect(result.status).toBe(503);
        expect(result.body).toMatchObject({ retryable: true, queued: true, paused: true });
        expect(supabase.campaignRecord).toMatchObject({ status: 'sending', background_delivery_enabled: true });
        expect(Date.parse(String(result.body.nextAttemptAt)) - before).toBeLessThanOrEqual(61_000);
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('persists automatic continuation before template verification can be interrupted', async () => {
        const supabase = createSupabaseMock('draft', {
            messageText: serializeCampaignMessageSequence([{ text: 'Hello', templateName: 'general_msg_v1' }])
        });
        let finishCheck!: (templates: unknown[]) => void;
        let started!: () => void;
        const checking = new Promise<void>(resolve => { started = resolve; });
        vi.mocked(getPageTemplates).mockImplementationOnce(() => {
            started();
            return new Promise(resolve => { finishCheck = resolve; });
        });
        const pending = sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });
        await checking;
        const saved = { ...supabase.campaignRecord };
        finishCheck([]);
        await pending;
        expect(saved).toMatchObject({ status: 'sending', background_delivery_enabled: true });
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('does not let an automatic worker restart a manually stopped campaign', async () => {
        const supabase = createSupabaseMock('draft', { backgroundDeliveryEnabled: false });
        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never, backgroundOnly: true });
        expect(result.body.paused).toBe(true);
        expect(supabase.campaignUpdate).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('preserves a manual Stop that happens while a worker error is being recovered', async () => {
        const supabase = createSupabaseMock('sending');
        const rpc = supabase.rpc.getMockImplementation()!;
        supabase.rpc.mockImplementation(async (name, args) => {
            if (name === 'claim_campaign_recipients') {
                supabase.campaignRecord.status = 'draft';
                supabase.campaignRecord.background_delivery_enabled = false;
                throw new Error('Network timeout');
            }
            return rpc(name, args);
        });
        await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });
        expect(supabase.campaignRecord).toMatchObject({ status: 'draft', background_delivery_enabled: false });
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it.each([
        { status: 502, message: 'Bad Gateway' },
        { name: 'AbortError', message: 'The operation was aborted' },
        Object.assign(new Error('Request Timeout'), { status: 408 })
    ])('retains recipients and automatically resumes after a temporary send failure: %j', async failure => {
        vi.useFakeTimers();
        const supabase = createSupabaseMock('draft', {
            recipients: [{ id: 'r', contact_id: 'c', contacts: { psid: 'psid' } }]
        });
        vi.mocked(sendMessage).mockRejectedValueOnce(failure).mockResolvedValue({ message_id: 'accepted' });
        const options = { campaignId: 'campaign_1', supabase: supabase as never, sendRetryAttempts: 0 };
        const deferred = await sendCampaignById(options);
        expect(deferred.body).toMatchObject({ retryable: true, remaining: 1, sent: 0, failed: 0 });
        expect(supabase.finishBatchRpc).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(60_000);
        const resumed = await sendCampaignById({ ...options, backgroundOnly: true });
        expect(resumed.body).toMatchObject({ success: true, sent: 1, failed: 0 });
        expect(supabase.campaignRecord.status).toBe('completed');
    });

    it('honors a manual Stop made while the Page lease is being acquired', async () => {
        const supabase = createSupabaseMock('sending');
        const rpc = supabase.rpc.getMockImplementation()!;
        supabase.rpc.mockImplementation(async (name, args) => {
            const result = await rpc(name, args);
            if (name === 'acquire_page_campaign_delivery') {
                supabase.campaignRecord.status = 'draft';
                supabase.campaignRecord.background_delivery_enabled = false;
            }
            return result;
        });
        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never, backgroundOnly: true });
        expect(result.body.paused).toBe(true);
        expect(supabase.campaignRecord.status).toBe('draft');
        expect(supabase.claimRpc).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('resumes an older complete audience when the database supplies its update timestamp', async () => {
        const supabase = createSupabaseMock('draft', {
            legacyAudience: true, serverUpdatedAt: '2026-11-08T00:00:00.123456+00:00',
            recipients: [{ id: 'r', contact_id: 'c', contacts: { psid: 'psid' } }]
        });
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'accepted' });
        const result = await sendCampaignById({ campaignId: 'campaign_1', supabase: supabase as never });
        expect(result.body).toMatchObject({ success: true, sent: 1 });
        expect(supabase.campaignRecord.status).toBe('completed');
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
        expect(supabase.claimRpc).toHaveBeenCalledTimes(42);
        expect(supabase.claimRpc).toHaveBeenNthCalledWith(1, expect.objectContaining({ p_batch_size: 50 }));
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
        expect(supabase.claimRpc).toHaveBeenCalledTimes(1);
        expect(supabase.claimRpc).toHaveBeenLastCalledWith(expect.objectContaining({ p_batch_size: 10 }));
    });

    it('resumes a 10,005-recipient queue after the browser stops at 3,500 without resending completed contacts', async () => {
        const recipients = Array.from({ length: 10005 }, (_, index) => ({
            id: `recipient_${index}`, contact_id: `contact_${index}`,
            contacts: { psid: `psid_${index}`, name: `Contact ${index}` }
        }));
        const supabase = createSupabaseMock('draft', { recipients });
        vi.mocked(sendMessage).mockResolvedValue({ message_id: 'accepted' });
        const slice = { campaignId: 'campaign_1', supabase: supabase as never, maxRecipientsPerRun: 500 };
        let result = await sendCampaignById({ ...slice, userId: 'member' });
        for (let run = 1; run < 7; run++) {
            result = await sendCampaignById({ ...slice, userId: 'member' });
        }
        expect(result.body).toMatchObject({ partial: true, sent: 3500, remaining: 6505 });

        // Later background invocations use the same persisted recipient queue.
        for (let run = 0; run < 14; run++) result = await sendCampaignById(slice);

        expect(result.body).toMatchObject({ success: true, sent: 10005, failed: 0 });
        expect(result.body.partial).not.toBe(true);
        expect(sendMessage).toHaveBeenCalledTimes(10005);
        expect(new Set(vi.mocked(sendMessage).mock.calls.map(args => args[2])).size).toBe(10005);
        expect(supabase.campaignUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed' }));
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
