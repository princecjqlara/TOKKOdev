import { describe, expect, it, vi, afterEach } from 'vitest';
import { runContactSyncToCompletion } from '../contact-sync-client';

describe('runContactSyncToCompletion', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('continues partial contact sync responses until complete', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                success: true,
                partial: true,
                synced: 15,
                failed: 0,
                remainingPsids: ['psid_2']
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                success: true,
                partial: false,
                synced: 1,
                failed: 0,
                total: 16
            }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await runContactSyncToCompletion('page_1');

        expect(result.completed).toBe(true);
        expect(result.totalSynced).toBe(16);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
            forceFullSync: true,
            paged: true,
            resumePsids: ['psid_2']
        });
    });

    it('retries the same remaining psids after a transient timeout', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                success: true,
                partial: true,
                synced: 15,
                failed: 0,
                remainingPsids: ['psid_2', 'psid_3']
            }), { status: 200 }))
            .mockRejectedValueOnce(new Error('504 Gateway Timeout'))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                success: true,
                partial: false,
                synced: 2,
                failed: 0,
                total: 17
            }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await runContactSyncToCompletion('page_1');

        expect(result.completed).toBe(true);
        expect(result.totalSynced).toBe(17);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
            forceFullSync: true,
            paged: true,
            resumePsids: ['psid_2', 'psid_3']
        });
        expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
            forceFullSync: true,
            paged: true,
            resumePsids: ['psid_2', 'psid_3']
        });
    });

    it('continues cursor pages past the previous fixed continuation cap', async () => {
        let callNumber = 0;
        const fetchMock = vi.fn(async (): Promise<Response> => {
            callNumber += 1;

            if (callNumber <= 101) {
                return new Response(JSON.stringify({
                    success: true,
                    partial: true,
                    synced: 100,
                    failed: 0,
                    cursor: `cursor_${callNumber}`,
                    nextCursor: `cursor_${callNumber}`,
                    syncStartedAt: '2026-04-07T01:00:00.000Z'
                }), { status: 200 });
            }

            return new Response(JSON.stringify({
                success: true,
                partial: false,
                synced: 1,
                failed: 0,
                total: 1,
                syncStartedAt: '2026-04-07T01:00:00.000Z'
            }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await runContactSyncToCompletion('page_1');

        expect(result.completed).toBe(true);
        expect(result.totalSynced).toBe(10101);
        expect(fetchMock).toHaveBeenCalledTimes(102);
        const fetchCalls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
        expect(JSON.parse(String(fetchCalls[101][1].body))).toEqual({
            forceFullSync: true,
            paged: true,
            cursor: 'cursor_101',
            syncStartedAt: '2026-04-07T01:00:00.000Z'
        });
    });

    it('finishes remaining psids before advancing to the next Facebook cursor', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                success: true,
                partial: true,
                synced: 15,
                failed: 0,
                remainingPsids: ['psid_2'],
                cursor: 'current_cursor',
                nextCursor: 'next_cursor',
                syncStartedAt: '2026-04-07T01:00:00.000Z'
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                success: true,
                partial: true,
                synced: 1,
                failed: 0,
                cursor: 'next_cursor',
                nextCursor: 'next_cursor',
                syncStartedAt: '2026-04-07T01:00:00.000Z'
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                success: true,
                partial: false,
                synced: 1,
                failed: 0,
                total: 17,
                syncStartedAt: '2026-04-07T01:00:00.000Z'
            }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await runContactSyncToCompletion('page_1');

        expect(result.completed).toBe(true);
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
            forceFullSync: true,
            paged: true,
            resumePsids: ['psid_2'],
            cursor: 'current_cursor',
            syncStartedAt: '2026-04-07T01:00:00.000Z'
        });
        expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
            forceFullSync: true,
            paged: true,
            cursor: 'next_cursor',
            syncStartedAt: '2026-04-07T01:00:00.000Z'
        });
    });
});
