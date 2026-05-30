import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    subscribePageToAppWebhook: vi.fn()
}));

vi.mock('@/lib/get-session', () => ({
    getSessionFromRequest: mocks.getSessionFromRequest
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/facebook', () => ({
    subscribePageToAppWebhook: mocks.subscribePageToAppWebhook
}));

import { POST } from './route';

function createRequest(): NextRequest {
    return new Request('http://localhost:3000/api/pages/page_row_1/webhook', {
        method: 'POST'
    }) as unknown as NextRequest;
}

function createSupabaseMock({ hasAccess = true } = {}) {
    const userPageSingle = vi.fn().mockResolvedValue({
        data: hasAccess ? { page_id: 'page_row_1' } : null,
        error: null
    });
    const userPageEqPageId = vi.fn().mockReturnValue({ single: userPageSingle });
    const userPageEqUserId = vi.fn().mockReturnValue({ eq: userPageEqPageId });
    const userPageSelect = vi.fn().mockReturnValue({ eq: userPageEqUserId });

    const pageSingle = vi.fn().mockResolvedValue({
        data: {
            fb_page_id: 'fb_page_1',
            access_token: 'stored_page_access_token'
        },
        error: null
    });
    const pageEq = vi.fn().mockReturnValue({ single: pageSingle });
    const pageSelect = vi.fn().mockReturnValue({ eq: pageEq });

    const from = vi.fn((table: string) => {
        if (table === 'user_pages') {
            return {
                select: userPageSelect
            };
        }

        if (table === 'pages') {
            return {
                select: pageSelect
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return { from };
}

describe('POST /api/pages/[pageId]/webhook', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('subscribes an authorized page using stored page token', async () => {
        mocks.getSessionFromRequest.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });
        mocks.subscribePageToAppWebhook.mockResolvedValue(undefined);
        const supabase = createSupabaseMock({ hasAccess: true });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest(), {
            params: Promise.resolve({ pageId: 'page_row_1' })
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(mocks.subscribePageToAppWebhook).toHaveBeenCalledWith(
            'fb_page_1',
            'stored_page_access_token',
            ['messages', 'messaging_postbacks']
        );
    });

    it('returns 403 when user does not have page access', async () => {
        mocks.getSessionFromRequest.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });
        const supabase = createSupabaseMock({ hasAccess: false });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest(), {
            params: Promise.resolve({ pageId: 'page_row_1' })
        });
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body.error).toBe('Forbidden');
        expect(mocks.subscribePageToAppWebhook).not.toHaveBeenCalled();
    });

    it('returns 409 when facebook rejects the stored page token', async () => {
        mocks.getSessionFromRequest.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });
        mocks.subscribePageToAppWebhook.mockRejectedValue(
            new Error(
                'Any of the pages_read_engagement, pages_manage_metadata, pages_read_user_content, pages_manage_ads, pages_show_list or pages_messaging permission(s) must be granted before impersonating a user\'s page.'
            )
        );
        const supabase = createSupabaseMock({ hasAccess: true });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest(), {
            params: Promise.resolve({ pageId: 'page_row_1' })
        });
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body.error).toBe('Page Reconnect Required');
        expect(body.requiresReconnect).toBe(true);
    });

    it('returns 502 when facebook subscription fails for a non-token reason', async () => {
        mocks.getSessionFromRequest.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });
        mocks.subscribePageToAppWebhook.mockRejectedValue(
            new Error('Facebook did not confirm webhook subscription for this page')
        );
        const supabase = createSupabaseMock({ hasAccess: true });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest(), {
            params: Promise.resolve({ pageId: 'page_row_1' })
        });
        const body = await response.json();

        expect(response.status).toBe(502);
        expect(body.error).toBe('Webhook Subscription Failed');
    });
});
