import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ process: vi.fn() }));
vi.mock('@/lib/messaging-auto-tag-worker', () => ({ processOneMessagingAutoTagPage: mocks.process }));
import { GET } from './route';

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('public messaging auto-tag worker', () => {
    it.each([undefined, 'legacy-worker-secret'])('runs without scheduler credentials when CRON_SECRET is %s', async secret => {
        vi.stubEnv('CRON_SECRET', secret);
        mocks.process.mockResolvedValue({ pages: 1, conversations: 10, tagged: 2 });

        const response = await GET();

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ success: true, pages: 1, conversations: 10, tagged: 2 });
        expect(mocks.process).toHaveBeenCalledOnce();
    });

    it('still reports worker failures after accepting an unauthenticated invocation', async () => {
        mocks.process.mockRejectedValue(new Error('Database unavailable'));

        const response = await GET();

        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: 'Messaging auto-tag sync failed' });
    });
});
