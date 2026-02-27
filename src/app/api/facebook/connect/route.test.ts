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
    return new Request('http://localhost:3000/api/facebook/connect', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            fbPageId: 'fb_page_1',
            name: 'My Page',
            accessToken: 'page_access_token_1'
        })
    }) as unknown as NextRequest;
}

function createSupabaseMock() {
    const pageSelectSingle = vi.fn().mockResolvedValue({ data: { id: 'page_row_1' }, error: null });
    const pageSelectEq = vi.fn().mockReturnValue({ single: pageSelectSingle });
    const pageSelect = vi.fn().mockReturnValue({ eq: pageSelectEq });

    const pageUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const pageUpdate = vi.fn().mockReturnValue({ eq: pageUpdateEq });

    const userPagesUpsert = vi.fn().mockResolvedValue({ error: null });

    const from = vi.fn((table: string) => {
        if (table === 'pages') {
            return {
                select: pageSelect,
                update: pageUpdate
            };
        }

        if (table === 'user_pages') {
            return {
                upsert: userPagesUpsert
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from
    };
}

describe('POST /api/facebook/connect', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('subscribes the page to webhook events before saving connection', async () => {
        const supabase = createSupabaseMock();

        mocks.getSessionFromRequest.mockResolvedValue({
            user: {
                id: 'user_1',
                email: 'user@example.com'
            }
        });
        mocks.subscribePageToAppWebhook.mockResolvedValue(undefined);
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(mocks.subscribePageToAppWebhook).toHaveBeenCalledWith(
            'fb_page_1',
            'page_access_token_1',
            ['messages', 'messaging_postbacks']
        );
        expect(supabase.from).toHaveBeenCalledWith('pages');
        expect(supabase.from).toHaveBeenCalledWith('user_pages');
    });

    it('returns 502 and skips database writes when webhook subscription fails', async () => {
        mocks.getSessionFromRequest.mockResolvedValue({
            user: {
                id: 'user_1',
                email: 'user@example.com'
            }
        });
        mocks.subscribePageToAppWebhook.mockRejectedValue(
            new Error('Requires pages_manage_metadata permission')
        );

        const response = await POST(createRequest());
        const body = await response.json();

        expect(response.status).toBe(502);
        expect(body.error).toBe('Webhook Subscription Failed');
        expect(body.message).toContain('Requires pages_manage_metadata permission');
        expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    });
});
