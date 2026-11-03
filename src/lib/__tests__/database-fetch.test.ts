import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabaseFetch } from '../database-fetch';
import { databaseRequest, DATABASE_REQUEST_TIMEOUT_MS } from '../database-request';

const base = 'https://test-project.supabase.co';
const rest = `${base}/rest/v1/pages`;
const response = (status = 200, headers?: HeadersInit) => new Response(JSON.stringify(status < 400 ? [] : { message: 'upstream failure' }), { status, headers });
const mockTransport = () => vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-04T00:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('Supabase REST usage protection', () => {
    it('passes healthy reads and writes through without retrying or caching their results', async () => {
        const transport = mockTransport().mockImplementation(async () => response());
        const guarded = createDatabaseFetch(base, transport);
        const write = { method: 'POST', body: JSON.stringify({ id: 'one' }) };
        await guarded(rest);
        await guarded(rest, write);
        expect(transport.mock.calls).toEqual([[rest, undefined], [rest, write]]);
    });

    it('waits five minutes after a quota failure, then automatically permits recovery', async () => {
        const transport = mockTransport().mockResolvedValueOnce(response(402)).mockImplementation(async () => response());
        const guarded = createDatabaseFetch(base, transport);
        expect((await guarded(rest)).status).toBe(402);
        const blocked = await guarded(`${base}/rest/v1/contacts`, { method: 'POST', body: '{}' });
        expect(blocked.status).toBe(503);
        expect(blocked.headers.get('retry-after')).toBe('300');
        expect(await blocked.json()).toMatchObject({ code: 'DATABASE_BACKOFF' });
        await vi.advanceTimersByTimeAsync(299_999);
        expect((await guarded(rest)).status).toBe(503);
        expect(transport).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        expect((await guarded(rest)).status).toBe(200);
        expect((await guarded(rest)).status).toBe(200);
        expect(transport).toHaveBeenCalledTimes(3);
    });

    it('increases the delay after repeated service failures instead of replaying failed operations', async () => {
        const transport = mockTransport().mockImplementation(async () => response(521));
        const guarded = createDatabaseFetch(base, transport);
        await guarded(rest, { method: 'POST', body: '{}' });
        expect((await guarded(rest)).headers.get('retry-after')).toBe('30');
        await vi.advanceTimersByTimeAsync(30_000);
        await guarded(rest);
        expect((await guarded(rest)).headers.get('retry-after')).toBe('60');
        expect(transport).toHaveBeenCalledTimes(2);
    });

    it.each(['120', 'Wed, 04 Nov 2026 00:02:00 GMT'])('respects a rate-limit Retry-After header: %s', async retryAfter => {
        const transport = mockTransport().mockResolvedValue(response(429, { 'Retry-After': retryAfter }));
        const guarded = createDatabaseFetch(base, transport);
        await guarded(rest);
        expect((await guarded(rest)).headers.get('retry-after')).toBe('120');
        expect(transport).toHaveBeenCalledOnce();
    });

    it('allows only one recovery probe at a time', async () => {
        let finish!: (value: Response) => void;
        const transport = mockTransport().mockResolvedValueOnce(response(503))
            .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
            .mockImplementation(async () => response());
        const guarded = createDatabaseFetch(base, transport);
        await guarded(rest);
        await vi.advanceTimersByTimeAsync(30_000);
        const probe = guarded(rest);
        expect((await guarded(rest)).status).toBe(503);
        expect(transport).toHaveBeenCalledTimes(2);
        finish(response());
        await probe;
        expect((await guarded(rest)).status).toBe(200);
    });

    it.each([400, 401, 403, 404, 409])('does not turn a query or permission error into a shared outage: %i', async status => {
        const transport = mockTransport().mockImplementation(async () => response(status));
        const guarded = createDatabaseFetch(base, transport);
        expect((await guarded(rest)).status).toBe(status);
        expect((await guarded(rest)).status).toBe(status);
        expect(transport).toHaveBeenCalledTimes(2);
    });

    it('does not let an older successful request clear a newer outage', async () => {
        let finish!: (value: Response) => void;
        const transport = mockTransport().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
            .mockResolvedValueOnce(response(521));
        const guarded = createDatabaseFetch(base, transport);
        const earlier = guarded(rest);
        await guarded(rest);
        finish(response());
        await earlier;
        expect((await guarded(rest)).status).toBe(503);
        expect(transport).toHaveBeenCalledTimes(2);
    });

    it('cools down after a network failure but preserves caller-initiated cancellation', async () => {
        const failure = new TypeError('fetch failed');
        const transport = mockTransport().mockRejectedValueOnce(failure).mockImplementation(async () => response());
        const guarded = createDatabaseFetch(base, transport);
        await expect(guarded(rest)).rejects.toBe(failure);
        expect((await guarded(rest)).status).toBe(503);
        expect(transport).toHaveBeenCalledOnce();

        const controller = new AbortController();
        controller.abort();
        const cancelledTransport = mockTransport().mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))
            .mockImplementation(async () => response());
        const cancelled = createDatabaseFetch(base, cancelledTransport);
        await expect(cancelled(rest, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect((await cancelled(rest)).status).toBe(200);
    });

    it('does not block Storage or other origins when REST is unavailable', async () => {
        const transport = mockTransport().mockResolvedValueOnce(response(521)).mockImplementation(async () => response());
        const guarded = createDatabaseFetch(base, transport);
        await guarded(rest);
        expect((await guarded(`${base}/storage/v1/object/media/photo`)).status).toBe(200);
        expect((await guarded('https://graph.facebook.com/rest/v1/pages')).status).toBe(200);
        expect(transport).toHaveBeenCalledTimes(3);
    });

    it('keeps Supabase reads and writes failed during cooldown without issuing more HTTP requests', async () => {
        const transport = mockTransport().mockResolvedValueOnce(response(402));
        const db = createClient(base, 'test-key', { global: { fetch: createDatabaseFetch(base, transport) }, auth: { persistSession: false, autoRefreshToken: false } });
        expect((await db.from('pages').select('id')).status).toBe(402);
        const blocked = await db.from('contacts').upsert({ id: 'one' });
        expect(blocked).toMatchObject({ data: null, status: 503, error: { code: 'DATABASE_BACKOFF' } });
        expect(transport).toHaveBeenCalledOnce();
    });

    it('backs off when the application deadline aborts a stalled Supabase query', async () => {
        const transport = mockTransport().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
        }));
        const db = createClient(base, 'test-key', { global: { fetch: createDatabaseFetch(base, transport) }, auth: { persistSession: false, autoRefreshToken: false } });
        const failure = expect(databaseRequest(db.from('pages').select('id'))).rejects.toMatchObject({ code: 'DATABASE_TIMEOUT' });
        await vi.advanceTimersByTimeAsync(DATABASE_REQUEST_TIMEOUT_MS);
        await failure;
        expect(await db.from('contacts').select('id')).toMatchObject({ data: null, status: 503, error: { code: 'DATABASE_BACKOFF' } });
        expect(transport).toHaveBeenCalledOnce();
    });
});
