import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    userHasPageAccess: vi.fn(),
    processConversationExportQueue: vi.fn()
}));

vi.mock('@/lib/get-session', () => ({
    getSessionFromRequest: mocks.getSessionFromRequest
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/page-access', () => ({
    userHasPageAccess: mocks.userHasPageAccess
}));

vi.mock('@/lib/conversation-export-jobs', () => ({
    processConversationExportQueue: mocks.processConversationExportQueue
}));

import { POST } from './route';

function request() {
    return new Request('http://localhost/api/exports/job_1/retry', { method: 'POST' }) as NextRequest;
}

function context() {
    return { params: Promise.resolve({ exportId: 'job_1' }) };
}

function createSupabaseMock() {
    const lookup: Record<string, any> = {};
    lookup.select = vi.fn(() => lookup);
    lookup.eq = vi.fn(() => lookup);
    lookup.maybeSingle = vi.fn().mockResolvedValue({
        data: { id: 'job_1', page_id: 'page_1', status: 'failed' }, error: null
    });

    const update: Record<string, any> = {};
    update.update = vi.fn(() => update);
    update.eq = vi.fn(() => update);
    update.select = vi.fn(() => update);
    update.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'job_1' }, error: null });

    let exportJobQuery = 0;
    const supabase = {
        from: vi.fn(() => exportJobQuery++ === 0 ? lookup : update)
    };
    return { supabase, update };
}

describe('POST /api/exports/[exportId]/retry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'user_2' } });
        mocks.userHasPageAccess.mockResolvedValue(true);
        mocks.processConversationExportQueue.mockResolvedValue([]);
    });

    it('lets an authorized Page member retry another member’s export', async () => {
        const { supabase, update } = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(request(), context());

        expect(response.status).toBe(200);
        expect(mocks.userHasPageAccess).toHaveBeenCalledWith('user_2', 'page_1');
        expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }));
        expect(mocks.processConversationExportQueue).toHaveBeenCalledWith({
            jobId: 'job_1', maxBatches: 1, maxDurationMs: 240_000
        });
    });

    it('does not retry an export from an inaccessible Page', async () => {
        const { supabase, update } = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.userHasPageAccess.mockResolvedValue(false);

        const response = await POST(request(), context());

        expect(response.status).toBe(404);
        expect(update.update).not.toHaveBeenCalled();
        expect(mocks.processConversationExportQueue).not.toHaveBeenCalled();
    });
});
