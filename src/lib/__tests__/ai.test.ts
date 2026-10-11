import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePersonalizedMessage } from '../ai';

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('AI message generation', () => {
    it('aborts a stalled request and returns a fallback instead of blocking delivery', async () => {
        vi.useFakeTimers();
        vi.stubEnv('NVIDIA_API_KEY', 'test-key');
        let signal!: AbortSignal;
        vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => {
            signal = init.signal as AbortSignal;
            return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
        }));

        const pending = generatePersonalizedMessage('Follow up', 'Alex');
        await vi.advanceTimersByTimeAsync(10000);

        expect(signal.aborted).toBe(true);
        expect(await pending).toBe("Hi Alex! Just wanted to check in with you. Hope you're doing well!");
        expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the timeout after successful generation', async () => {
        vi.useFakeTimers();
        vi.stubEnv('NVIDIA_API_KEY', 'test-key');
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true, json: async () => ({ choices: [{ message: { content: 'Checking in, Alex!' } }] })
        }));

        expect(await generatePersonalizedMessage('Follow up', 'Alex')).toBe('Checking in, Alex!');
        expect(vi.getTimerCount()).toBe(0);
    });
});
