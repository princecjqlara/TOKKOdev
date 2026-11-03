import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

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

function createRequest(search = ''): NextRequest {
    return new NextRequest(`http://localhost:3000/api/pages${search}`);
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

    return { from, select, eq };
}

describe('GET /api/pages', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'user_1', provider: 'facebook' } });
        mocks.getSupabaseAdmin.mockReturnValue(createSupabaseMock());
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

    it('preserves assigned Page access when its Facebook connection expires', async () => {
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
            '606945225824770',
            '697291860141214'
        ]);
        expect(body.reconnectRequiredPages.map((page: { fb_page_id: string }) => page.fb_page_id)).toEqual([
            '697291860141214'
        ]);
        expect(body.reconnectRequiredPages[0].requiresReconnect).toBe(true);
        expect(body.pages[0].requiresReconnect).toBe(false);
        expect(body.pages[1].requiresReconnect).toBe(true);
        expect(JSON.stringify(body)).not.toMatch(/access_token|old_invalid_token|fresh_valid_token/);

        const membershipBody = await (await GET(createRequest('?membershipOnly=1'))).json();
        expect(body.pages.map((page: { id: string }) => page.id).sort())
            .toEqual(membershipBody.pages.map((page: { id: string }) => page.id).sort());
    });

    it('keeps the workspace available when every assigned Facebook connection is invalid', async () => {
        vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({
            error: { code: 190, message: 'Error validating access token' }
        }), { status: 400 }));

        const response = await GET(createRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.pages.map((page: { id: string }) => page.id).sort()).toEqual(['fresh_page', 'old_page']);
        expect(body.pages.every((page: { requiresReconnect: boolean }) => page.requiresReconnect)).toBe(true);
        expect(body.reconnectRequiredPages).toEqual(body.pages);
    });

    it('retains assigned Pages whose saved Facebook token is missing', async () => {
        const db = createSupabaseMock();
        db.eq.mockResolvedValue({ data: [{ page_id: 'missing_page', pages: {
            id: 'missing_page', fb_page_id: 'missing_fb', name: 'Assigned Page', access_token: null
        } }], error: null });
        mocks.getSupabaseAdmin.mockReturnValue(db);

        const body = await (await GET(createRequest())).json();

        expect(body.pages).toEqual([expect.objectContaining({ id: 'missing_page', requiresReconnect: true })]);
        expect(body.reconnectRequiredPages).toEqual(body.pages);
        expect(fetch).not.toHaveBeenCalled();
        expect(JSON.stringify(body)).not.toContain('access_token');
    });

    it.each(['network', 'server'])('preserves Page access during a Facebook %s failure', async failure => {
        vi.mocked(fetch).mockImplementation(async () => {
            if (failure === 'network') throw new TypeError('fetch failed');
            return new Response(JSON.stringify({ error: { code: 2, message: 'Service unavailable' } }), { status: 503 });
        });

        const response = await GET(createRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.pages).toHaveLength(2);
        expect(body.reconnectRequiredPages).toEqual([]);
    });

    it.each([
        { provider: 'credentials', search: '' },
        { provider: 'facebook', search: '?membershipOnly=1' }
    ])('loads assigned Pages without Facebook calls for %j', async ({ provider, search }) => {
        const db = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(db);
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'assigned_user', provider } });

        const response = await GET(createRequest(search));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.pages).toHaveLength(2);
        expect(db.eq).toHaveBeenCalledWith('user_id', 'assigned_user');
        expect(fetch).not.toHaveBeenCalled();
        expect(JSON.stringify(body)).not.toMatch(/access_token|old_invalid_token|fresh_valid_token/);
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('requires sign-in before querying Page assignments', async () => {
        mocks.getSessionFromRequest.mockResolvedValue(null);

        const response = await GET(createRequest());

        expect(response.status).toBe(401);
        expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('reports assignment lookup errors without treating them as removed access', async () => {
        const db = createSupabaseMock();
        db.eq.mockResolvedValue({ data: null, error: { code: '08000', message: 'Database unavailable' } });
        mocks.getSupabaseAdmin.mockReturnValue(db);

        const response = await GET(createRequest());
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.pages).toBeUndefined();
        expect(db.eq).toHaveBeenCalledWith('user_id', 'user_1');
        expect(fetch).not.toHaveBeenCalled();
    });
});
