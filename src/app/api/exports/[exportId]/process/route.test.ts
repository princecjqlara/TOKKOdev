import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn(),
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

import { POST } from './route';

function createSupabaseMock(job: { id: string; status: string } | null) {
    const maybeSingle = vi.fn().mockResolvedValue({ data: job, error: null });
    const secondEq = vi.fn().mockReturnValue({ maybeSingle });
    const firstEq = vi.fn().mockReturnValue({ eq: secondEq });
    const select = vi.fn().mockReturnValue({ eq: firstEq });
    return { from: vi.fn().mockReturnValue({ select }) };
}

describe('POST /api/exports/[exportId]/process', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'user_1' } });
        mocks.getSupabaseAdmin.mockReturnValue(createSupabaseMock({ id: 'job_1', status: 'queued' }));
        mocks.processConversationExportQueue.mockResolvedValue([{
            jobId: 'job_1', complete: false, processedItems: 25, conversations: 25, messages: 100
        }]);
    });

    it('processes one batch only after verifying export ownership', async () => {
        const response = await POST(
            new Request('http://localhost/api/exports/job_1/process', { method: 'POST' }) as NextRequest,
            { params: Promise.resolve({ exportId: 'job_1' }) }
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(mocks.processConversationExportQueue).toHaveBeenCalledWith({
            jobId: 'job_1', maxBatches: 1, maxDurationMs: 240_000
        });
        expect(body.result).toMatchObject({ processedItems: 25, messages: 100 });
    });

    it('does not process an export belonging to another user', async () => {
        mocks.getSupabaseAdmin.mockReturnValue(createSupabaseMock(null));

        const response = await POST(
            new Request('http://localhost/api/exports/job_1/process', { method: 'POST' }) as NextRequest,
            { params: Promise.resolve({ exportId: 'job_1' }) }
        );

        expect(response.status).toBe(404);
        expect(mocks.processConversationExportQueue).not.toHaveBeenCalled();
    });
});
