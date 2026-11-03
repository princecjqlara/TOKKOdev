import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountRequest, ACCOUNT_REQUEST_TIMEOUT_MS } from '../account-request';

afterEach(() => { vi.useRealTimers(); });

describe('authentication request deadline', () => {
    it('returns the database response and removes its deadline when the request finishes', async () => {
        vi.useFakeTimers();
        const result = { data: { id: 'verified-account' }, error: null };
        expect(await accountRequest(Promise.resolve(result))).toBe(result);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('aborts stalled transports and rejects even when the transport ignores cancellation', async () => {
        vi.useFakeTimers();
        let signal: AbortSignal | undefined;
        const request = Object.assign(new Promise<never>(() => {}), {
            abortSignal: (value: AbortSignal) => {
                signal = value;
                return new Promise<never>(() => {});
            }
        });
        const result = accountRequest(request);
        const rejection = expect(result).rejects.toMatchObject({ status: 503 });
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(ACCOUNT_REQUEST_TIMEOUT_MS);
        await rejection;
        expect(signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('preserves a database failure and clears the timer without waiting for the deadline', async () => {
        vi.useFakeTimers();
        const error = new Error('database unavailable');
        await expect(accountRequest(Promise.reject(error))).rejects.toBe(error);
        expect(vi.getTimerCount()).toBe(0);
    });
});
