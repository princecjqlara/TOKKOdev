import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATABASE_REQUEST_TIMEOUT_MS } from '../database-request';
import { claimCampaignRecipients, finishCampaignRecipientBatch, getCampaignDeliveryProgress } from '../campaign-recipient-queue';

vi.mock('../supabase', () => ({ getSupabaseAdmin: vi.fn() }));

const results = [{ contact_id: 'contact', success: true, error_message: null }];
afterEach(() => { vi.useRealTimers(); });

describe('saving campaign delivery results', () => {
    it.each([null, [], {}, [{ sent_count: 1, failed_count: 0 }], [{ sent_count: -1, failed_count: 0, remaining_count: 0 }]])(
        'does not interpret missing or invalid progress as a completed campaign: %j', async data => {
            const rpc = vi.fn().mockResolvedValue({ data, error: null });
            await expect(getCampaignDeliveryProgress({ rpc } as never, 'campaign')).rejects.toThrow('valid campaign delivery progress');
        });

    it('reads exact million-recipient counters including bigint strings', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: [{ sent_count: 500, failed_count: 1, remaining_count: '1999504' }], error: null });
        expect(await getCampaignDeliveryProgress({ rpc } as never, 'campaign')).toEqual({ sent: 500, failed: 1, remaining: 1999504 });
    });

    it('keeps a missing claim response retryable instead of treating it as an empty queue', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
        await expect(claimCampaignRecipients({ supabase: { rpc } as never, campaignId: 'campaign', batchSize: 25 }))
            .rejects.toThrow('valid campaign recipient batch');
    });
    it('retries a thrown database deadline with the same claim and delivery results', async () => {
        vi.useFakeTimers();
        const rpc = vi.fn().mockImplementationOnce(() => new Promise(() => {}))
            .mockResolvedValue({ data: 1, error: null });
        const pending = finishCampaignRecipientBatch({ supabase: { rpc } as never,
            campaignId: 'campaign', claimToken: 'claim', results });
        await vi.advanceTimersByTimeAsync(DATABASE_REQUEST_TIMEOUT_MS + 250);
        await pending;
        expect(rpc).toHaveBeenCalledTimes(2);
        expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('retries both incomplete results and transport errors before the third save succeeds', async () => {
        vi.useFakeTimers();
        const rpc = vi.fn().mockResolvedValueOnce({ data: 0, error: null })
            .mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValue({ data: 1, error: null });
        const pending = finishCampaignRecipientBatch({ supabase: { rpc } as never,
            campaignId: 'campaign', claimToken: 'claim', results });
        await vi.advanceTimersByTimeAsync(750);
        await pending;
        expect(rpc).toHaveBeenCalledTimes(3);
        expect(rpc.mock.calls[2]).toEqual(rpc.mock.calls[0]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('bounds each save run at three attempts so the campaign can defer to a later worker', async () => {
        vi.useFakeTimers();
        const error = new Error('database connection failed');
        const rpc = vi.fn().mockRejectedValue(error);
        const pending = finishCampaignRecipientBatch({ supabase: { rpc } as never,
            campaignId: 'campaign', claimToken: 'claim', results });
        const rejected = expect(pending).rejects.toBe(error);
        await vi.advanceTimersByTimeAsync(750);
        await rejected;
        expect(rpc).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(0);
    });
});
