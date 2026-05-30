import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    subscribePageToAppWebhook: vi.fn(),
    getPageTemplates: vi.fn(),
    createUtilityTemplate: vi.fn()
}));

vi.mock('@/lib/get-session', () => ({
    getSessionFromRequest: mocks.getSessionFromRequest
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/facebook', () => ({
    subscribePageToAppWebhook: mocks.subscribePageToAppWebhook,
    getPageTemplates: mocks.getPageTemplates,
    createUtilityTemplate: mocks.createUtilityTemplate
}));

vi.mock('@/lib/facebook-templates', () => ({
    UTILITY_TEMPLATES: []
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
        mocks.getPageTemplates.mockResolvedValue([]);
    });

    it('saves the fresh page token and subscribes the page to webhook events', async () => {
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

    it('still saves the fresh page token when webhook subscription fails', async () => {
        const supabase = createSupabaseMock();

        mocks.getSessionFromRequest.mockResolvedValue({
            user: {
                id: 'user_1',
                email: 'user@example.com'
            }
        });
        mocks.subscribePageToAppWebhook.mockRejectedValue(
            new Error('Requires pages_manage_metadata permission')
        );
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.warning.code).toBe('WEBHOOK_SUBSCRIPTION_FAILED');
        expect(body.message).toContain('Requires pages_manage_metadata permission');
        expect(supabase.from).toHaveBeenCalledWith('pages');
        expect(supabase.from).toHaveBeenCalledWith('user_pages');
    });
});
