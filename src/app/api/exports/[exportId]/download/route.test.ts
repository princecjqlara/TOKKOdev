import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn()
}));

vi.mock('@/lib/get-session', () => ({
    getSessionFromRequest: mocks.getSessionFromRequest
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/conversation-export-jobs', () => ({
    CONVERSATION_EXPORT_BUCKET: 'conversation-exports'
}));

import { GET } from './route';

function request() {
    return new Request('http://localhost:3000/api/exports/job_1/download') as unknown as NextRequest;
}

function context() {
    return { params: Promise.resolve({ exportId: 'job_1' }) };
}

function createSupabaseMock(job: Record<string, unknown> | null) {
    const builder: Record<string, any> = {};
    for (const method of ['select', 'eq']) builder[method] = vi.fn(() => builder);
    builder.single = vi.fn().mockResolvedValue({
        data: job,
        error: job ? null : { message: 'Not found' }
    });

    const chunks = [
        'pageId,pageName\n"page_1","My Page"',
        '\n"page_1","My Page"'
    ];
    const download = vi.fn(async (path: string) => {
        const index = Number(path.match(/chunk-(\d+)\.csv$/)?.[1]);
        return { data: new Blob([chunks[index]]), error: null };
    });
    const supabase = {
        from: vi.fn(() => builder),
        storage: { from: vi.fn(() => ({ download })) }
    };
    return { supabase, download };
}

describe('GET /api/exports/[exportId]/download', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'user_1' } });
    });

    it('streams every stored chunk as one authenticated CSV download', async () => {
        const { supabase, download } = createSupabaseMock({
            status: 'completed',
            filename: 'my-page-conversations.csv',
            storage_prefix: 'user_1/job_1',
            chunk_count: 2,
            expires_at: new Date(Date.now() + 60_000).toISOString()
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await GET(request(), context());

        expect(response.status).toBe(200);
        expect(response.headers.get('content-disposition')).toBe('attachment; filename="my-page-conversations.csv"');
        expect(await response.text()).toBe('pageId,pageName\n"page_1","My Page"\n"page_1","My Page"');
        expect(download).toHaveBeenCalledTimes(2);
    });

    it('does not expose an unfinished export', async () => {
        const { supabase, download } = createSupabaseMock({
            status: 'running', filename: 'file.csv', storage_prefix: 'user_1/job_1',
            chunk_count: 1, expires_at: new Date(Date.now() + 60_000).toISOString()
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await GET(request(), context());

        expect(response.status).toBe(409);
        expect(download).not.toHaveBeenCalled();
    });

    it('requires a signed-in user', async () => {
        mocks.getSessionFromRequest.mockResolvedValue(null);

        const response = await GET(request(), context());

        expect(response.status).toBe(401);
        expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    });
});
