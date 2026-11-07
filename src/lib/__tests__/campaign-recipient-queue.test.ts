import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATABASE_REQUEST_TIMEOUT_MS } from '../database-request';
import { finishCampaignRecipientBatch } from '../campaign-recipient-queue';

vi.mock('../supabase', () => ({ getSupabaseAdmin: vi.fn() }));

const results = [{ contact_id: 'contact', success: true, error_message: null }];
afterEach(() => { vi.useRealTimers(); });

describe('saving campaign delivery results', () => {
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
