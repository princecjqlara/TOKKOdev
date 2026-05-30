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
                    updated_at: '2026-05-28T10:51:13.713873+00:00',
                    access_token: 'old_invalid_token'
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
                    updated_at: '2026-05-30T03:46:03.957463+00:00',
                    access_token: 'fresh_valid_token'
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
        vi.unstubAllGlobals();
        vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
            const pathnameParts = url.pathname.split('/');
            const fbPageId = pathnameParts[pathnameParts.length - 1];

            return new Response(
                JSON.stringify({
                    id: fbPageId
                }),
                {
                    status: 200,
                    headers: {
                        'content-type': 'application/json'
                    }
                }
            );
        }));
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
        expect(body.pages.every((page: { access_token?: string }) => !page.access_token)).toBe(true);
    });

    it('excludes invalid page-token records from normal page selectors', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
            const accessToken = url.searchParams.get('access_token');

            if (accessToken === 'old_invalid_token') {
                return new Response(
                    JSON.stringify({
                        error: {
                            code: 190,
                            message: 'Any of the pages_read_engagement, pages_manage_metadata, pages_read_user_content, pages_manage_ads, pages_show_list or pages_messaging permission(s) must be granted before impersonating a user\'s page.'
                        }
                    }),
                    {
                        status: 400,
                        headers: {
                            'content-type': 'application/json'
                        }
                    }
                );
            }

            return new Response(
                JSON.stringify({
                    id: '606945225824770'
                }),
                {
                    status: 200,
                    headers: {
                        'content-type': 'application/json'
                    }
                }
            );
        }));
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
            '606945225824770'
        ]);
        expect(body.reconnectRequiredPages.map((page: { fb_page_id: string }) => page.fb_page_id)).toEqual([
            '697291860141214'
        ]);
        expect(body.reconnectRequiredPages[0].requiresReconnect).toBe(true);
    });
});
