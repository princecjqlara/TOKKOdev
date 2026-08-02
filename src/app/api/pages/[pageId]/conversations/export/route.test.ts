import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    getConversationIdForPsid: vi.fn(),
    getPageConversations: vi.fn(),
    getConversationMessages: vi.fn(),
    isFacebookReauthRequired: vi.fn()
}));

vi.mock('@/lib/get-session', () => ({
    getSessionFromRequest: mocks.getSessionFromRequest
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/facebook', () => ({
    getConversationIdForPsid: mocks.getConversationIdForPsid,
    getPageConversations: mocks.getPageConversations,
    getConversationMessages: mocks.getConversationMessages,
    isFacebookReauthRequired: mocks.isFacebookReauthRequired
}));

import { GET, POST } from './route';

function createRequest(format: 'csv' | 'json' = 'csv'): NextRequest {
    return new Request(`http://localhost:3000/api/pages/page_1/conversations/export?format=${format}`) as unknown as NextRequest;
}

function createPostRequest(body: Record<string, unknown>): NextRequest {
    return new Request('http://localhost:3000/api/pages/page_1/conversations/export', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    }) as unknown as NextRequest;
}

function createSupabaseMock(options: { hasAccess?: boolean; hasPage?: boolean } = {}) {
    const hasAccess = options.hasAccess !== false;
    const hasPage = options.hasPage !== false;

    const userPageSingle = vi.fn().mockResolvedValue({
        data: hasAccess ? { page_id: 'page_1' } : null,
        error: null
    });
    const userPageEqPage = vi.fn().mockReturnValue({ single: userPageSingle });
    const userPageEqUser = vi.fn().mockReturnValue({ eq: userPageEqPage });
    const userPageSelect = vi.fn().mockReturnValue({ eq: userPageEqUser });

    const pageSingle = vi.fn().mockResolvedValue({
        data: hasPage
            ? {
                fb_page_id: 'fb_page_1',
                access_token: 'page_access_token_1',
                name: 'Study Page'
            }
            : null,
        error: null
    });
    const pageEq = vi.fn().mockReturnValue({ single: pageSingle });
    const pageSelect = vi.fn().mockReturnValue({ eq: pageEq });

    const contactsIn = vi.fn().mockResolvedValue({
        data: [
            {
                id: 'contact_1',
                psid: 'contact_psid_1',
                name: 'Jane Contact'
            }
        ],
        error: null
    });
    const contactsEq = vi.fn().mockReturnValue({ in: contactsIn });
    const contactsSelect = vi.fn().mockReturnValue({ eq: contactsEq });

    const from = vi.fn((table: string) => {
        if (table === 'user_pages') {
            return { select: userPageSelect };
        }

        if (table === 'pages') {
            return { select: pageSelect };
        }

        if (table === 'contacts') {
            return { select: contactsSelect };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return { from, contactsIn };
}

describe('GET /api/pages/[pageId]/conversations/export', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionFromRequest.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });
        mocks.getSupabaseAdmin.mockReturnValue(createSupabaseMock());
        mocks.isFacebookReauthRequired.mockReturnValue(false);
        mocks.getConversationIdForPsid.mockResolvedValue('conversation_1');
        mocks.getPageConversations.mockResolvedValue([
            {
                id: 'conversation_1',
                updated_time: '2026-07-26T10:00:00.000Z',
                participants: {
                    data: [
                        { id: 'fb_page_1', name: 'Study Page' },
                        { id: 'contact_psid_1', name: 'Jane Contact' }
                    ]
                }
            }
        ]);
        mocks.getConversationMessages.mockResolvedValue([
            {
                id: 'message_1',
                message: 'Hello, "Jane"',
                from: {
                    id: 'contact_psid_1',
                    name: 'Jane Contact'
                },
                created_time: '2026-07-26T09:59:00.000Z'
            },
            {
                id: 'message_2',
                message: 'Thanks for messaging us',
                from: {
                    id: 'fb_page_1',
                    name: 'Study Page'
                },
                created_time: '2026-07-26T10:00:00.000Z'
            }
        ]);
    });

    it('downloads a CSV transcript for all accessible conversations', async () => {
        const response = await GET(createRequest('csv'), {
            params: Promise.resolve({ pageId: 'page_1' })
        });
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/csv');
        expect(response.headers.get('content-disposition')).toContain('Study-Page-conversations-');
        expect(mocks.getPageConversations).toHaveBeenCalledWith('fb_page_1', 'page_access_token_1', 100, true);
        expect(mocks.getConversationMessages).toHaveBeenCalledWith(
            'conversation_1',
            'page_access_token_1',
            Number.MAX_SAFE_INTEGER
        );
        expect(body).toContain('pageId,pageName,fbPageId,conversationId');
        expect(body).toContain('"contact_psid_1","Jane Contact","message_1","contact_psid_1","Jane Contact","contact","Hello, ""Jane"""');
        expect(body).toContain('"message_2","fb_page_1","Study Page","page","Thanks for messaging us"');
    });

    it('downloads a JSON transcript when requested', async () => {
        const response = await GET(createRequest('json'), {
            params: Promise.resolve({ pageId: 'page_1' })
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(response.headers.get('content-disposition')).toContain('.json');
        expect(body.page).toEqual({
            id: 'page_1',
            name: 'Study Page',
            fbPageId: 'fb_page_1'
        });
        expect(body.conversationCount).toBe(1);
        expect(body.messageCount).toBe(2);
        expect(body.messages[0]).toEqual(expect.objectContaining({
            conversationId: 'conversation_1',
            contactPsid: 'contact_psid_1',
            senderType: 'contact',
            message: 'Hello, "Jane"'
        }));
    });

    it('downloads full conversations for selected contact IDs only', async () => {
        const response = await POST(createPostRequest({
            format: 'csv',
            contactIds: ['contact_1']
        }), {
            params: Promise.resolve({ pageId: 'page_1' })
        });
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get('content-disposition')).toContain('Study-Page-selected-contact-conversations-');
        expect(mocks.getPageConversations).not.toHaveBeenCalled();
        expect(mocks.getConversationIdForPsid).toHaveBeenCalledWith(
            'fb_page_1',
            'contact_psid_1',
            'page_access_token_1'
        );
        expect(mocks.getConversationMessages).toHaveBeenCalledWith(
            'conversation_1',
            'page_access_token_1',
            Number.MAX_SAFE_INTEGER
        );
        expect(body).toContain('"contact_psid_1","Jane Contact","message_1"');
        expect(body).toContain('"message_2","fb_page_1","Study Page","page","Thanks for messaging us"');
    });

    it('returns 403 when the user does not have page access', async () => {
        mocks.getSupabaseAdmin.mockReturnValue(createSupabaseMock({ hasAccess: false }));

        const response = await GET(createRequest('csv'), {
            params: Promise.resolve({ pageId: 'page_1' })
        });
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body.error).toBe('Forbidden');
        expect(mocks.getPageConversations).not.toHaveBeenCalled();
    });

    it('returns reconnect guidance when Facebook rejects the page token', async () => {
        mocks.getPageConversations.mockRejectedValue(new Error('missing permissions'));
        mocks.isFacebookReauthRequired.mockReturnValue(true);

        const response = await GET(createRequest('csv'), {
            params: Promise.resolve({ pageId: 'page_1' })
        });
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body.requiresReconnect).toBe(true);
    });
});
