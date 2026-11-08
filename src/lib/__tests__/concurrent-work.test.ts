import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapConcurrentSettled } from '../concurrent-work';

afterEach(() => { vi.useRealTimers(); });

describe('rolling concurrent work', () => {
    it('refills available slots while an unrelated recipient is slow', async () => {
        vi.useFakeTimers();
        const completed: number[] = [];
        let inFlight = 0, maximum = 0;
        const pending = mapConcurrentSettled([0, 1, 2, 3, 4, 5], 2, async item => {
            maximum = Math.max(maximum, ++inFlight);
            await new Promise(resolve => setTimeout(resolve, item === 0 ? 1000 : 10));
            inFlight--; completed.push(item); return item;
        });
        await vi.advanceTimersByTimeAsync(60);
        expect(completed).toEqual([1, 2, 3, 4, 5]);
        expect(maximum).toBe(2);
        await vi.runAllTimersAsync();
        expect((await pending).map(result => result.status === 'fulfilled' ? result.value : null)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('isolates recipient failures and drains active work before reporting a checkpoint failure', async () => {
        vi.useFakeTimers();
        const completed: number[] = [];
        const pending = mapConcurrentSettled([0, 1, 2, 3], 2, async item => {
            await new Promise(resolve => setTimeout(resolve, item === 0 ? 100 : 10));
            completed.push(item); return item;
        }, async () => { throw new Error('Checkpoint failed'); });
        const failure = expect(pending).rejects.toThrow('Checkpoint failed');
        await vi.runAllTimersAsync();
        await failure;
        expect(completed.sort()).toEqual([0, 1]);
        const results = await mapConcurrentSettled([0, 1, 2], 2, async item => {
            if (item === 1) throw new Error('Recipient unavailable');
            return item;
        });
        expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    });
});
