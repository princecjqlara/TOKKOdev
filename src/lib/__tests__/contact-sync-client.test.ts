import { describe, expect, it, vi, afterEach } from 'vitest';
import { CONTACT_SYNC_REQUEST_TIMEOUT_MS, runContactSyncToCompletion } from '../contact-sync-client';

describe('runContactSyncToCompletion', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it.each(['fetch', 'body'])('times out a stalled %s and retries the same run without losing its continuation', async stage => {
        vi.useFakeTimers();
        const stalled = new Promise<Response>(() => {});
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(Response.json({ success: true, partial: true, synced: 1, nextCursor: 'next' }))
            .mockImplementationOnce(() => stage === 'fetch' ? stalled : Promise.resolve({ ok: true, text: () => new Promise(() => {}) }))
            .mockResolvedValueOnce(Response.json({ success: true, synced: 1 }));
        vi.stubGlobal('fetch', fetchMock);
        const pending = runContactSyncToCompletion('page_1');
        await vi.advanceTimersByTimeAsync(CONTACT_SYNC_REQUEST_TIMEOUT_MS + 1500);
        const result = await pending;
        expect(result.totalSynced).toBe(2);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
        expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[2][1].body);
        expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({ cursor: 'next' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not claim completion when a partial response has no continuation', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ success: true, partial: true })));
        await expect(runContactSyncToCompletion('page_1')).rejects.toThrow('without a continuation');
    });

    it('retains one run across 100,001 simulated contacts without truncating cursor continuations', async () => {
        let requests = 0;
        const transport = vi.fn(async () => {
            requests++;
            return Response.json(requests <= 1000
                ? { success: true, partial: true, synced: 100, nextCursor: `cursor_${requests}` }
                : { success: true, partial: false, synced: 1 });
        });
        vi.stubGlobal('fetch', transport);
        const result = await runContactSyncToCompletion('page_1');
        expect(result.completed).toBe(true);
        expect(result.totalSynced).toBe(100001);
        expect(transport).toHaveBeenCalledTimes(1001);
        const calls = transport.mock.calls as unknown as Array<[string, RequestInit]>;
        expect(new Set(calls.map(call => JSON.parse(String(call[1].body)).syncRunId)).size).toBe(1);
        expect(JSON.parse(String(calls[1000][1].body))).toMatchObject({ cursor: 'cursor_1000' });
    });

    it('continues durable imports through every folder even when a folder ends without a cursor', async () => {
        const run='00000000-0000-4000-8000-000000000001';
        const fetchMock=vi.fn()
            .mockResolvedValueOnce(Response.json({success:true,durable:true,partial:true,synced:100,totalSynced:100,folder:'other',syncRunId:run,cursor:null}))
            .mockResolvedValueOnce(Response.json({success:true,durable:true,partial:true,synced:5,totalSynced:105,folder:'page_done',syncRunId:run,cursor:null}))
            .mockResolvedValueOnce(Response.json({success:true,durable:true,partial:true,synced:2,totalSynced:107,folder:'spam',syncRunId:run,cursor:null}))
            .mockResolvedValueOnce(Response.json({success:true,durable:true,partial:false,synced:0,totalSynced:107,folder:'spam',syncRunId:run,cursor:null}));
        vi.stubGlobal('fetch',fetchMock);
        const result=await runContactSyncToCompletion('page_1');
        expect(result.totalSynced).toBe(107);expect(result.completed).toBe(true);expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({importOnly:true,syncRunId:run});
    });

    it('stops a cyclic durable cursor even if the processed count keeps increasing',async()=>{
        const transport=vi.fn()
            .mockResolvedValueOnce(Response.json({success:true,durable:true,partial:true,folder:'inbox',cursor:'a',totalSynced:100}))
            .mockResolvedValueOnce(Response.json({success:true,durable:true,partial:true,folder:'inbox',cursor:'b',totalSynced:200}))
            .mockResolvedValueOnce(Response.json({success:true,durable:true,partial:true,folder:'inbox',cursor:'a',totalSynced:300}));
        vi.stubGlobal('fetch',transport);await expect(runContactSyncToCompletion('page')).rejects.toThrow('made no progress');
        expect(transport).toHaveBeenCalledTimes(3);
    });

    it('reports optional tagging failures without claiming contacts were omitted from a completed import',async()=>{
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({success:true,durable:true,partial:false,totalSynced:100,tagFailures:2})));
        const result=await runContactSyncToCompletion('page');
        expect(result).toMatchObject({completed:true,totalSynced:100,totalFailed:2});
    });

    it('waits for a durable worker and uses cumulative saved totals without double counting', async () => {
        vi.useFakeTimers();
        const fetchMock=vi.fn()
            .mockResolvedValueOnce(Response.json({success:true,durable:true,partial:true,waiting:true,totalSynced:100,folder:'inbox',cursor:'saved',retryAfterMs:2000}))
            .mockResolvedValueOnce(Response.json({success:true,durable:true,partial:true,totalSynced:200,synced:100,folder:'other',cursor:null}))
            .mockResolvedValueOnce(Response.json({success:true,durable:true,partial:false,totalSynced:200,synced:0,folder:'spam',cursor:null}));
        vi.stubGlobal('fetch',fetchMock);const pending=runContactSyncToCompletion('page_1');
        await vi.advanceTimersByTimeAsync(2000);
        expect((await pending).totalSynced).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(3);
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

        const result = await runContactSyncToCompletion('page_1', { autoTag: false });

        expect(result.completed).toBe(true);
        expect(result.totalSynced).toBe(16);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(expect.objectContaining({
            forceFullSync: true,
            autoTag: false,
            paged: true,
            resumePsids: ['psid_2'],
            syncRunId: expect.any(String)
        }));
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
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(expect.objectContaining({
            forceFullSync: true,
            paged: true,
            resumePsids: ['psid_2', 'psid_3'],
            syncRunId: expect.any(String)
        }));
        expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual(expect.objectContaining({
            forceFullSync: true,
            paged: true,
            resumePsids: ['psid_2', 'psid_3'],
            syncRunId: expect.any(String)
        }));
    });

    it('does not retry when another sync already owns the page lease', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            error: 'Sync already running',
            message: 'A contact sync is already running for this page.'
        }), { status: 409 }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(runContactSyncToCompletion('page_1')).rejects.toThrow(
            'A contact sync is already running for this page.'
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('carries failures from an earlier cursor page to the final sync request', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, partial: true, synced: 1, failed: 1,
                nextCursor: 'next', syncHadFailures: true }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, synced: 1, failed: 0 }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await runContactSyncToCompletion('page_1');

        expect(result.totalFailed).toBe(1);
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ cursor: 'next', syncHadFailures: true });
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
        expect(JSON.parse(String(fetchCalls[101][1].body))).toEqual(expect.objectContaining({
            forceFullSync: true,
            paged: true,
            cursor: 'cursor_101',
            syncStartedAt: '2026-04-07T01:00:00.000Z',
            syncRunId: expect.any(String)
        }));
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
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(expect.objectContaining({
            forceFullSync: true,
            paged: true,
            resumePsids: ['psid_2'],
            cursor: 'current_cursor',
            syncStartedAt: '2026-04-07T01:00:00.000Z',
            syncRunId: expect.any(String)
        }));
        expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual(expect.objectContaining({
            forceFullSync: true,
            paged: true,
            cursor: 'next_cursor',
            syncStartedAt: '2026-04-07T01:00:00.000Z',
            syncRunId: expect.any(String)
        }));
    });
});
