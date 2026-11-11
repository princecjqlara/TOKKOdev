import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdaptiveDeliveryController } from '../adaptive-delivery';
import { readMetaDeliveryFeedback } from '../meta-delivery-feedback';

afterEach(() => { vi.useRealTimers(); });

describe('learning the available Meta sending capacity', () => {
    it('increases speed gradually when real responses show low usage', async () => {
        vi.useFakeTimers();
        const controller = new AdaptiveDeliveryController(100, 5, 20);
        let active = 0, peak = 0;
        const jobs = Array.from({ length: 1000 }, () => controller.run(async () => {
            peak = Math.max(peak, ++active);
            await new Promise(resolve => setTimeout(resolve, 200));
            active--;
            controller.observeSuccess({ usagePercent: 10 });
        }));
        const done = Promise.all(jobs);
        await vi.runAllTimersAsync(); await done;
        expect(controller.concurrency).toBeGreaterThan(5);
        expect(controller.intervalMs).toBeLessThan(20);
        expect(peak).toBeGreaterThan(5);
        expect(peak).toBeLessThanOrEqual(100);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reduces active capacity and spaces messages when usage rises before an error', async () => {
        vi.useFakeTimers();
        const controller = new AdaptiveDeliveryController(100, 20, 0);
        const starts: number[] = [];
        const jobs = Array.from({ length: 50 }, () => controller.run(async () => {
            starts.push(Date.now());
            await new Promise(resolve => setTimeout(resolve, 100));
            controller.observeSuccess({ usagePercent: 95 });
        }));
        const done = Promise.all(jobs);
        await vi.runAllTimersAsync(); await done;
        expect(controller.concurrency).toBeLessThanOrEqual(10);
        expect(controller.intervalMs).toBeGreaterThanOrEqual(50);
        expect(starts.slice(21).some((time, index) => time - starts[index + 20] >= 50)).toBe(true);
        expect(controller.limited).toBe(false);
    });

    it('stops queued starts immediately, honors Retry-After, and identifies an app-wide throttle', async () => {
        vi.useFakeTimers();
        const controller = new AdaptiveDeliveryController(100, 4, 0);
        let starts = 0;
        const before = Date.now();
        const jobs = Array.from({ length: 100 }, (_, i) => controller.run(async () => {
            starts++;
            await new Promise(resolve => setTimeout(resolve, 10));
            if (i === 0) throw Object.assign(new Error('Application request limit reached'), { status: 429, code: 4, retryAfterMs: 120_000 });
            controller.observeSuccess();
        }));
        const done = Promise.allSettled(jobs);
        await vi.runAllTimersAsync();
        const results = await done;
        expect(starts).toBe(4);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3);
        expect(controller.concurrency).toBe(2);
        expect(controller.retryAt - before).toBeGreaterThanOrEqual(120_000);
        expect(controller.scope).toBe('app');
        expect(controller.intervalMs).toBeGreaterThanOrEqual(100);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('defers proactively when quota is exhausted, including a successful final message', async () => {
        vi.useFakeTimers();
        const controller = new AdaptiveDeliveryController(100, 10, 0);
        await controller.run(async () => { controller.observeSuccess({ usagePercent: 100, retryAfterMs: 60_000 }); return 'accepted'; });
        expect(controller.limited).toBe(true);
        await expect(controller.run(async () => 'unexpected')).rejects.toMatchObject({ status: 429 });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps accepted requests moving slowly at full reported usage without inventing a rate-limit error', async () => {
        vi.useFakeTimers();
        const controller = new AdaptiveDeliveryController(100, 5, 0);
        const starts: number[] = [];
        const jobs = Array.from({ length: 12 }, () => controller.run(async () => {
            starts.push(Date.now());
            controller.observeSuccess({ usagePercent: 100, scope: 'app' });
            return 'accepted';
        }));
        const completed = Promise.allSettled(jobs);
        await vi.runAllTimersAsync();

        expect((await completed).every(result => result.status === 'fulfilled')).toBe(true);
        expect(starts).toHaveLength(12);
        expect(starts.slice(1).every((time, index) => time - starts[index] >= 5000)).toBe(true);
        expect(controller.concurrency).toBe(1);
        expect(controller.limited).toBe(false);
        expect(controller.retryAt).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('honors an explicit provider recovery time even when no usage percentage is reported', async () => {
        vi.useFakeTimers();
        const controller = new AdaptiveDeliveryController(100, 5, 0);
        const before = Date.now();
        controller.observeSuccess({ retryAfterMs: 120_000, scope: 'app' });
        expect(controller.limited).toBe(true);
        expect(controller.providerRetryAt).toBe(before + 120_000);
        await expect(controller.run(async () => 'unexpected')).rejects.toMatchObject({ status: 429 });
    });

    it.each([17, 32, 613])('uses the scope of throttle code %i instead of inferring an app limit from usage', async code => {
        const controller = new AdaptiveDeliveryController(100, 10, 100);
        await expect(controller.run(async () => {
            throw Object.assign(new Error('Connection request limit reached'), { code, status: 429,
                retryAfterMs: 120_000, usagePercent: 90, scope: 'app' });
        })).rejects.toMatchObject({ code });
        expect(controller.limited).toBe(true);
        expect(controller.scope).toBe(code === 17 ? 'user' : 'page');
    });

    it('keeps a business-use-case recovery estimate local when app usage is the higher percentage', () => {
        const controller = new AdaptiveDeliveryController(100, 10, 100);
        const feedback = readMetaDeliveryFeedback(new Headers({
            'x-app-usage': JSON.stringify({ call_count: 90 }),
            'x-business-use-case-usage': JSON.stringify({ business: [{ type: 'messenger', call_count: 20,
                estimated_time_to_regain_access: 3 }] })
        }));
        controller.observeSuccess(feedback);
        expect(controller.limited).toBe(true);
        expect(controller.scope).toBe('page');
        expect(controller.providerRetryAt).toBeGreaterThanOrEqual(Date.now() + 179_000);
    });

    it('does not turn a request Retry-After into an app-wide delay from an unrelated usage percentage', () => {
        const feedback = readMetaDeliveryFeedback(new Headers({
            'x-app-usage': JSON.stringify({ call_count: 80 }), 'retry-after': '120'
        }));
        const controller = new AdaptiveDeliveryController(100, 10, 100);
        controller.observeSuccess(feedback);
        expect(controller.limited).toBe(true);
        expect(controller.scope).toBe('page');
    });

    it('rejects a queued operation cleanly when its allowed callback yields the slice', async () => {
        const controller = new AdaptiveDeliveryController(100, 1, 0);
        const yielded = new Error('Slice ended');
        await expect(controller.run(async () => 'unexpected', () => { throw yielded; })).rejects.toBe(yielded);
        expect(await controller.run(async () => 'next')).toBe('next');
    });

    it('does not interpret missing headers as instant recovery from recent pressure', async () => {
        vi.useFakeTimers();
        const controller = new AdaptiveDeliveryController(100, 10, 100);
        controller.observeSuccess({ usagePercent: 95 });
        const reduced = controller.concurrency;
        for (let i = 0; i < 50; i++) controller.observeSuccess();
        expect(controller.concurrency).toBe(reduced);
        await vi.advanceTimersByTimeAsync(31_000);
        for (let i = 0; i < 25; i++) controller.observeSuccess();
        expect(controller.concurrency).toBeGreaterThan(reduced);
    });

    it('recovers slow pacing within short worker slices when Meta omits usage headers', async () => {
        vi.useFakeTimers();
        let concurrency = 1, intervalMs = 5000;
        // Each browser slice has less than 45 seconds for sending. Requiring
        // 25 successes at five-second spacing loses every sample on restart.
        for (let slice = 0; slice < 3; slice++) {
            const controller = new AdaptiveDeliveryController(100, concurrency, intervalMs);
            for (let response = 0; response < 6; response++) {
                await vi.advanceTimersByTimeAsync(intervalMs);
                controller.observeSuccess();
            }
            expect(controller.intervalMs).toBeLessThan(intervalMs);
            concurrency = controller.concurrency;
            intervalMs = controller.intervalMs;
        }
        expect(concurrency).toBeGreaterThan(1);
    });

    it('learns capacity from recipient rejections without treating them as delivered messages', async () => {
        vi.useFakeTimers();
        const controller = new AdaptiveDeliveryController(100, 1, 5000);
        const starts: number[] = [];
        const jobs = Array.from({ length: 12 }, () => controller.run(async () => {
            starts.push(Date.now());
            throw Object.assign(new Error("(#551) This person isn't available right now."), { status: 400, code: 551 });
        }));
        const pending = Promise.allSettled(jobs);
        await vi.runAllTimersAsync();
        expect((await pending).every(result => result.status === 'rejected')).toBe(true);
        expect(controller.concurrency).toBeGreaterThan(1);
        expect(controller.intervalMs).toBeLessThan(5000);
        expect(controller.limited).toBe(false);
        expect(starts[starts.length - 1] - starts[0]).toBeLessThan(55_000);
    });

    it('honors pressure headers even when Meta rejects an individual recipient', async () => {
        vi.useFakeTimers();
        const controller = new AdaptiveDeliveryController(100, 20, 10);
        await expect(controller.run(async () => {
            throw Object.assign(new Error("This person isn't available right now."), { status: 400, code: 551,
                usagePercent: 100, scope: 'app' });
        })).rejects.toMatchObject({ code: 551 });
        expect(controller.concurrency).toBe(1);
        expect(controller.intervalMs).toBe(5000);
        expect(controller.limited).toBe(false);
        const delayed = expect(controller.run(async () => {
            throw Object.assign(new Error("This person isn't available right now."), { status: 400, code: 551,
                retryAfterMs: 120_000, scope: 'app' });
        })).rejects.toMatchObject({ code: 551 });
        await vi.runAllTimersAsync();
        await delayed;
        expect(controller.limited).toBe(true);
        expect(controller.scope).toBe('app');
    });

    it('probes slowly after a recovery hold instead of accelerating on every second of clean replies', async () => {
        vi.useFakeTimers();
        const controller = new AdaptiveDeliveryController(100, 5, 1000, Date.now() - 1);
        for (let second = 0; second < 60; second++) {
            await vi.advanceTimersByTimeAsync(1000);
            for (let response = 0; response < 25; response++) controller.observeSuccess({ usagePercent: 5 });
        }
        expect(controller.concurrency).toBeGreaterThan(5);
        expect(controller.concurrency).toBeLessThanOrEqual(10);
        expect(controller.intervalMs).toBeGreaterThanOrEqual(400);
    });

    it('retains a shared recovery pace across worker restarts despite clean replies', async () => {
        vi.useFakeTimers();
        const growthAfter = Date.now() + 10 * 60_000;
        for (let worker = 0; worker < 3; worker++) {
            const controller = new AdaptiveDeliveryController(100, 1, 5000, growthAfter);
            for (let response = 0; response < 20; response++) {
                await vi.advanceTimersByTimeAsync(5000);
                controller.observeSuccess({ usagePercent: 5 });
            }
            expect(controller.concurrency).toBe(1);
            expect(controller.intervalMs).toBe(5000);
            expect(controller.limited).toBe(false);
        }
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        const recovered = new AdaptiveDeliveryController(100, 1, 5000, growthAfter);
        for (let response = 0; response < 5; response++) {
            await vi.advanceTimersByTimeAsync(5000);
            recovered.observeSuccess({ usagePercent: 5 });
        }
        expect(recovered.concurrency).toBeGreaterThan(1);
        expect(recovered.intervalMs).toBeLessThan(5000);
    });
});

describe('Meta response feedback', () => {
    it('keeps observed business objects and use cases separate from unrelated quota headers', () => {
        const feedback = readMetaDeliveryFeedback(new Headers({
            'x-business-use-case-usage': JSON.stringify({ '123': [
                { type: 'messenger', call_count: 75, estimated_time_to_regain_access: 2 },
                { type: 'ads_management', call_count: 100, estimated_time_to_regain_access: 60 }
            ], '456': [{ type: 'pages', call_count: 30 }] })
        }));
        expect(feedback).toMatchObject({ usagePercent: 75, scope: 'business', scopeKey: '123:messenger',
            retryAfterMs: 120_000, businessKeys: ['123:messenger', '456:pages'] });
    });

    it('retains the recovery object even when another business has higher usage', () => {
        const feedback = readMetaDeliveryFeedback(new Headers({ 'x-business-use-case-usage': JSON.stringify({
            '123': [{ type: 'messenger', call_count: 95 }],
            '456': [{ type: 'messenger', call_count: 20, estimated_time_to_regain_access: 3 }]
        }) }));
        expect(feedback).toMatchObject({ scope: 'business', scopeKey: '123:messenger',
            retryScope: 'business', retryScopeKey: '456:messenger', retryAfterMs: 180_000 });
    });
    it('reads nested business usage, app usage and the provider recovery interval', () => {
        const headers = new Headers({
            'x-app-usage': JSON.stringify({ call_count: 40, total_time: 10 }),
            'x-business-use-case-usage': JSON.stringify({ 'page-id': [{ call_count: 90, total_cputime: 20, estimated_time_to_regain_access: 3 }] }),
            'retry-after': '30'
        });
        expect(readMetaDeliveryFeedback(headers)).toEqual({ usagePercent: 90, retryAfterMs: 180_000, scope: 'page' });
    });

    it('supports HTTP-date Retry-After and ignores malformed optional fields', () => {
        const now = Date.parse('2026-11-08T12:00:00Z');
        expect(readMetaDeliveryFeedback(new Headers({ 'retry-after': 'Sun, 08 Nov 2026 12:01:00 GMT', 'x-page-usage': 'not-json' }), now))
            .toEqual({ retryAfterMs: 60_000 });
        expect(readMetaDeliveryFeedback(new Headers({ 'x-app-usage': JSON.stringify({ call_count: -1, total_time: 'invalid' }) }))).toBeUndefined();
        expect(readMetaDeliveryFeedback()).toBeUndefined();
    });

    it('keeps app-wide pressure when page usage reports the same percentage', () => {
        const feedback = readMetaDeliveryFeedback(new Headers({
            'x-app-usage': JSON.stringify({ call_count: 100 }),
            'x-page-usage': JSON.stringify({ call_count: 100 })
        }));
        expect(feedback).toEqual({ usagePercent: 100, scope: 'app' });
    });
});
