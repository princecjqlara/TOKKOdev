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

vi.mock('@/lib/conversation-export-jobs', () => ({
    processConversationExportQueue: mocks.processConversationExportQueue
}));

vi.mock('@/lib/page-access', () => ({
    userHasPageAccess: mocks.userHasPageAccess
}));

import { POST } from './route';

function createSupabaseMock(job: { id: string; page_id: string; status: string } | null) {
    const builder: Record<string, any> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.maybeSingle = vi.fn().mockResolvedValue({ data: job, error: null });
    return { from: vi.fn(() => builder) };
}

describe('POST /api/exports/[exportId]/process', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'user_1' } });
        mocks.userHasPageAccess.mockResolvedValue(true);
        mocks.getSupabaseAdmin.mockReturnValue(createSupabaseMock({
            id: 'job_1', page_id: 'page_1', status: 'queued'
        }));
        mocks.processConversationExportQueue.mockResolvedValue([{
            jobId: 'job_1', complete: false, processedItems: 25, conversations: 25, messages: 100
        }]);
    });

    it('lets an authorized Page member process a shared export', async () => {
        const response = await POST(
            new Request('http://localhost/api/exports/job_1/process', { method: 'POST' }) as NextRequest,
            { params: Promise.resolve({ exportId: 'job_1' }) }
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(mocks.processConversationExportQueue).toHaveBeenCalledWith({
            jobId: 'job_1', maxBatches: 10, maxDurationMs: 50_000
        });
        expect(body.batchesProcessed).toBe(1);
        expect(body.result).toMatchObject({ processedItems: 25, messages: 100 });
        expect(mocks.userHasPageAccess).toHaveBeenCalledWith('user_1', 'page_1');
    });

    it('does not process an export from a Page the user cannot access', async () => {
        mocks.userHasPageAccess.mockResolvedValue(false);

        const response = await POST(
            new Request('http://localhost/api/exports/job_1/process', { method: 'POST' }) as NextRequest,
            { params: Promise.resolve({ exportId: 'job_1' }) }
        );

        expect(response.status).toBe(404);
        expect(mocks.processConversationExportQueue).not.toHaveBeenCalled();
    });
});
