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

import { GET } from './route';

function createRequest(): NextRequest {
    return new Request('http://localhost:3000/api/pages') as unknown as NextRequest;
}

function createSupabaseMock() {
    const eq = vi.fn().mockResolvedValue({
        data: [
            {
                page_id: 'old_page',
                pages: {
                    id: 'old_page',
                    fb_page_id: '697291860141214',
                    name: 'Hiraya Studio',
                    business_id: null,
                    created_at: '2025-12-14T13:16:51.46548+00:00',
                    updated_at: '2026-05-28T10:51:13.713873+00:00'
                }
            },
            {
                page_id: 'fresh_page',
                pages: {
                    id: 'fresh_page',
                    fb_page_id: '606945225824770',
                    name: 'Hiraya Studios',
                    business_id: null,
                    created_at: '2025-12-17T07:19:18.487574+00:00',
                    updated_at: '2026-05-30T03:46:03.957463+00:00'
                }
            }
        ],
        error: null
    });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });

    return { from };
}

describe('GET /api/pages', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns the most recently refreshed page first', async () => {
        mocks.getSessionFromRequest.mockResolvedValue({
            user: {
                id: 'user_1',
                email: 'user@example.com'
            }
        });
        mocks.getSupabaseAdmin.mockReturnValue(createSupabaseMock());

        const response = await GET(createRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.pages.map((page: { fb_page_id: string }) => page.fb_page_id)).toEqual([
            '606945225824770',
            '697291860141214'
        ]);
    });
});
