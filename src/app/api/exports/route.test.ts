import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    getUserPageIds: vi.fn()
}));

vi.mock('@/lib/get-session', () => ({
    getSessionFromRequest: mocks.getSessionFromRequest
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/page-access', () => ({
    getUserPageIds: mocks.getUserPageIds
}));

import { GET } from './route';

function createSupabaseMock(jobs: Record<string, unknown>[]) {
    const result = { data: jobs, error: null };
    const builder: Record<string, any> = {};
    for (const method of ['select', 'in', 'order']) builder[method] = vi.fn(() => builder);
    builder.limit = vi.fn().mockResolvedValue(result);
    return { supabase: { from: vi.fn(() => builder) }, builder };
}

describe('GET /api/exports', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'user_2' } });
        mocks.getUserPageIds.mockResolvedValue(['page_1', 'page_2']);
    });

    it('lists exports from every Page the signed-in member can access', async () => {
        const { supabase, builder } = createSupabaseMock([{
            id: 'job_from_user_1',
            page_id: 'page_1',
            status: 'completed',
            pages: { name: 'Shared Page' }
        }]);
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await GET(new Request('http://localhost/api/exports') as NextRequest);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(mocks.getUserPageIds).toHaveBeenCalledWith('user_2');
        expect(builder.in).toHaveBeenCalledWith('page_id', ['page_1', 'page_2']);
        expect(body.jobs).toEqual([{
            id: 'job_from_user_1',
            page_id: 'page_1',
            status: 'completed',
            page_name: 'Shared Page'
        }]);
    });

    it('returns no exports when the user has no Page memberships', async () => {
        mocks.getUserPageIds.mockResolvedValue([]);

        const response = await GET(new Request('http://localhost/api/exports') as NextRequest);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ jobs: [] });
        expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    });
});
