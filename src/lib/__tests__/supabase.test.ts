import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseErrorDetails, databaseRequest, DATABASE_REQUEST_TIMEOUT_MS } from '../database-request';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
});
const page = { id: 'page_1', access_token: 'test-page-token' };
const mockTransport = () => vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();

async function admin(transport: typeof fetch) {
    vi.stubGlobal('fetch', transport);
    const { getSupabaseAdmin } = await import('../supabase');
    return getSupabaseAdmin();
}

beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test-project.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

describe('independent Supabase admin requests', () => {
    it('uses the server database URL for backend requests and diagnostics when the public build setting is stale', async () => {
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://old-project.supabase.co');
        vi.stubEnv('SUPABASE_URL', 'https://new-project.supabase.co');
        const transport = mockTransport().mockResolvedValue(json(page));
        const db = await admin(transport);

        await db.from('pages').select('id').single();

        expect(new URL(String(transport.mock.calls[0][0])).hostname).toBe('new-project.supabase.co');
        expect(databaseErrorDetails({ code: 'DATABASE_TIMEOUT' }).databaseHost).toBe('new-project.supabase.co');
    });

    it('keeps the public client on its public URL and publishable key', async () => {
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://public-project.supabase.co');
        vi.stubEnv('SUPABASE_URL', 'https://server-project.supabase.co');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-publishable-key');
        const transport = mockTransport().mockResolvedValue(json(page));
        vi.stubGlobal('fetch', transport);
        const { getSupabaseClient } = await import('../supabase');

        await getSupabaseClient().from('pages').select('id').single();

        expect(new URL(String(transport.mock.calls[0][0])).hostname).toBe('public-project.supabase.co');
        expect(new Headers(transport.mock.calls[0][1]?.headers).get('apikey')).toBe('test-publishable-key');
    });

    it.each([402, 429, 500, 502, 503, 504, 521])('keeps an HTTP %i failure local to its request and sends subsequent reads and writes', async status => {
        const transport = mockTransport()
            .mockResolvedValueOnce(json({ code: 'UPSTREAM_FAILURE', message: 'upstream failure' }, status))
            .mockImplementation(async () => json(page));
        const db = await admin(transport);

        expect(await db.rpc('report')).toMatchObject({ status, data: null, error: { code: 'UPSTREAM_FAILURE' } });
        expect(await databaseRequest(db.from('pages').select('id, access_token').eq('fb_page_id', 'facebook_page_1').single()))
            .toMatchObject({ status: 200, error: null, data: page });
        expect(await db.from('contacts').upsert({ id: 'contact_1' })).toMatchObject({ status: 200, error: null });
        expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET', 'POST']);
    });

    it('does not let an isolated SQL timeout block a healthy webhook Page lookup', async () => {
        const transport = mockTransport()
            .mockResolvedValueOnce(json({ code: '57014', message: 'canceling statement due to statement timeout' }, 500))
            .mockResolvedValueOnce(json(page));
        const db = await admin(transport);

        expect(await db.rpc('slow_report')).toMatchObject({ status: 500, error: { code: '57014' } });
        expect(await databaseRequest(db.from('pages').select('id, access_token').eq('fb_page_id', 'facebook_page_1').single()))
            .toMatchObject({ status: 200, error: null, data: page });
        expect(transport).toHaveBeenCalledTimes(2);
    });

    it('does not let concurrent service failures suppress the next healthy request', async () => {
        const transport = mockTransport().mockImplementation(async () => json({ code: 'UPSTREAM_FAILURE' }, 503));
        const db = await admin(transport);
        await Promise.all(Array.from({ length: 6 }, () => db.rpc('report')));
        transport.mockResolvedValueOnce(json(page));

        expect(await db.from('pages').select('id').single()).toMatchObject({ status: 200, error: null, data: page });
        expect(transport).toHaveBeenCalledTimes(7);
    });

    it('does not let a network failure suppress the next request or replay a failed write', async () => {
        const transport = mockTransport().mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce(json(page));
        const db = await admin(transport);

        expect(await db.from('contacts').upsert({ id: 'contact_1' })).toMatchObject({ status: 0, data: null, error: expect.any(Object) });
        expect(await db.from('pages').select('id').single()).toMatchObject({ status: 200, error: null });
        expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET']);
    });

    it('bounds a stalled Page lookup without blocking the next delivery', async () => {
        vi.useFakeTimers();
        const transport = mockTransport().mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
        })).mockResolvedValueOnce(json(page));
        const db = await admin(transport);
        const failed = expect(databaseRequest(db.from('pages').select('id').single()))
            .rejects.toMatchObject({ code: 'DATABASE_TIMEOUT' });
        await vi.advanceTimersByTimeAsync(DATABASE_REQUEST_TIMEOUT_MS);
        await failed;

        expect(await databaseRequest(db.from('pages').select('id').single())).toMatchObject({ status: 200, error: null });
        expect(transport).toHaveBeenCalledTimes(2);
    });
});
