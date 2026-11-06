import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestWithTimeout } from '../request-timeout';

afterEach(() => { vi.useRealTimers(); });

describe('request deadlines', () => {
    it('rejects a stalled operation even if its transport ignores abort', async () => {
        vi.useFakeTimers();
        let signal: AbortSignal | undefined;
        const pending = requestWithTimeout(value => { signal = value; return new Promise(() => {}); }, 100, 'Request timed out');
        const failed = expect(pending).rejects.toThrow('Request timed out');
        await vi.advanceTimersByTimeAsync(100);
        await failed;
        expect(signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('honors parent cancellation immediately without starting another request', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        controller.abort();
        const operation = vi.fn();
        await expect(requestWithTimeout(operation, 100, 'Cancelled', controller.signal)).rejects.toThrow('Cancelled');
        expect(operation).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels an in-flight operation when the caller aborts and cleans up its deadline', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        let signal: AbortSignal | undefined;
        const pending = requestWithTimeout(value => { signal = value; return new Promise(() => {}); }, 100, 'Cancelled', controller.signal);
        const failed = expect(pending).rejects.toThrow('Cancelled');
        controller.abort();
        await failed;
        expect(signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('clears timers for completed operations and preserves ordinary errors', async () => {
        vi.useFakeTimers();
        expect(await requestWithTimeout(async () => 'ok', 100, 'Timeout')).toBe('ok');
        const error = new Error('Original error');
        await expect(requestWithTimeout(async () => { throw error; }, 100, 'Timeout')).rejects.toBe(error);
        expect(vi.getTimerCount()).toBe(0);
    });
});
