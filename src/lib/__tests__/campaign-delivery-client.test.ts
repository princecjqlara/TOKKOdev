import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAMPAIGN_DELIVERY_REQUEST_TIMEOUT_MS, runCampaignDelivery } from '../campaign-delivery-client';

const done = { success: true, sent: 3, failed: 1, remaining: 0 };
const slice = { success: true, partial: true, sent: 2, failed: 1, remaining: 1, processed: 3 };

describe('automatic bulk delivery continuation', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

    it('continues through repeated network failures without resetting the saved campaign', async () => {
        const fetch = vi.fn().mockResolvedValueOnce(Response.json(slice));
        for (let failure = 0; failure < 8; failure++) fetch.mockRejectedValueOnce(new TypeError('fetch failed'));
        fetch.mockResolvedValue(Response.json(done));
        vi.stubGlobal('fetch', fetch);
        const pending = runCampaignDelivery('saved', { expectedUpdatedAt: '2026-11-08T00:00:00Z' });
        await vi.runAllTimersAsync();
        expect(await pending).toMatchObject(done);
        expect(fetch).toHaveBeenCalledTimes(10);
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ backgroundOnly: false });
        for (const [url, init] of fetch.mock.calls.slice(1)) {
            expect(url).toBe('/api/campaigns/saved/send');
            expect(JSON.parse(init.body)).toMatchObject({ backgroundOnly: true });
        }
        expect(vi.getTimerCount()).toBe(0);
    });

    it('waits for the server cooldown and then resumes without inheriting paused flags', async () => {
        const retryAt = new Date(Date.now() + 300_000).toISOString();
        const fetch = vi.fn().mockResolvedValueOnce(Response.json({
            success: false, paused: true, retryable: true, queued: true, nextAttemptAt: retryAt, remaining: 3
        }, { status: 503 })).mockResolvedValueOnce(Response.json(slice)).mockResolvedValue(Response.json(done));
        vi.stubGlobal('fetch', fetch);
        const progress = vi.fn();
        const pending = runCampaignDelivery('saved', { onProgress: progress });
        await vi.advanceTimersByTimeAsync(299_999);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toMatchObject({ ...done, paused: false, retryable: false, queued: false });
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(progress).toHaveBeenCalledWith(expect.objectContaining({ retryable: true }));
    });

    it.each(['fetch', 'body'])('bounds a stalled %s and automatically retries the saved queue', async stage => {
        let stalledSignal: AbortSignal | undefined;
        const fetch = vi.fn().mockImplementationOnce((_url, init) => {
            stalledSignal = init.signal;
            return stage === 'fetch' ? new Promise(() => {}) : Promise.resolve({
                ok: true, status: 200, json: () => new Promise(() => {})
            });
        }).mockResolvedValue(Response.json(done));
        vi.stubGlobal('fetch', fetch);
        const pending = runCampaignDelivery('saved', { initial: { queued: true, remaining: 3 } });
        await vi.advanceTimersByTimeAsync(CAMPAIGN_DELIVERY_REQUEST_TIMEOUT_MS + 2_000);
        expect(await pending).toMatchObject(done);
        expect(stalledSignal?.aborted).toBe(true);
        expect(JSON.parse(fetch.mock.calls[1][1].body).backgroundOnly).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('recovers from an HTML gateway timeout and an incomplete success response', async () => {
        const fetch = vi.fn().mockResolvedValueOnce(new Response('<html>Gateway Timeout</html>', { status: 504 }))
            .mockResolvedValueOnce(new Response('{incomplete', { status: 200 })).mockResolvedValue(Response.json(done));
        vi.stubGlobal('fetch', fetch);
        const pending = runCampaignDelivery('saved');
        await vi.runAllTimersAsync();
        expect(await pending).toMatchObject(done);
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('waits and continues when another worker owns the remaining recipients', async () => {
        const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...slice, processed: 0 }))
            .mockResolvedValue(Response.json(done));
        vi.stubGlobal('fetch', fetch);
        const pending = runCampaignDelivery('saved');
        await vi.advanceTimersByTimeAsync(1_999);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toMatchObject(done);
    });

    it('keeps going after a queued HTTP 200 response without reporting completion', async () => {
        const fetch = vi.fn().mockResolvedValueOnce(Response.json({ success: true, queued: true, remaining: 3 }))
            .mockResolvedValue(Response.json(done));
        vi.stubGlobal('fetch', fetch);
        const pending = runCampaignDelivery('saved');
        await vi.runAllTimersAsync();
        expect(await pending).toMatchObject(done);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fetch.mock.calls[1][1].body).backgroundOnly).toBe(true);
    });

    it('does not exponentially back off when successful requests keep waiting for a healthy worker', async () => {
        const fetch = vi.fn();
        for (let i=0;i<10;i++) fetch.mockResolvedValueOnce(Response.json({ success: true, queued: true, remaining: 3 }));
        fetch.mockResolvedValue(Response.json(done));vi.stubGlobal('fetch',fetch);
        const pending=runCampaignDelivery('saved');
        await vi.advanceTimersByTimeAsync(20_000);
        expect(fetch).toHaveBeenCalledTimes(11);
        expect(await pending).toMatchObject(done);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('honors a manual Stop after a temporary failure', async () => {
        const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...slice, queued: true, retryable: true }))
            .mockResolvedValue(Response.json({ success: true, paused: true, retryable: false, remaining: 1 }));
        vi.stubGlobal('fetch', fetch);
        const pending = runCampaignDelivery('saved');
        await vi.runAllTimersAsync();
        expect(await pending).toMatchObject({ paused: true, retryable: false, remaining: 1 });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fetch.mock.calls[1][1].body).backgroundOnly).toBe(true);
    });

    it('immediately cancels a long cooldown wait when the user stops delivery', async () => {
        const fetch = vi.fn().mockResolvedValue(Response.json({ success: false, queued: true, retryable: true,
            nextAttemptAt: new Date(Date.now() + 60 * 60_000).toISOString() }, { status: 503 }));
        vi.stubGlobal('fetch', fetch);
        const controller = new AbortController();
        const pending = runCampaignDelivery('saved', { signal: controller.signal });
        const stopped = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await stopped;
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([401, 403, 409, 500])('surfaces an explicit permanent error (HTTP %i) without retrying', async status => {
        const fetch = vi.fn().mockResolvedValue(Response.json({ success: false, retryable: false, message: 'Page needs repair' }, { status }));
        vi.stubGlobal('fetch', fetch);
        await expect(runCampaignDelivery('saved')).rejects.toThrow('Page needs repair');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });
});
