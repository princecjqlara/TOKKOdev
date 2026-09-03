import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    getConversationIdForPsid: vi.fn(),
    getPageConversations: vi.fn(),
    getPageConversationsBatch: vi.fn(),
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
    getPageConversationsBatch: mocks.getPageConversationsBatch,
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

    const contactsIn = vi.fn((_column: string, contactIds: string[]) => Promise.resolve({
        data: contactIds.map((id) => id === 'contact_1'
            ? {
                id,
                psid: 'contact_psid_1',
                name: 'Jane Contact'
            }
            : {
                id,
                psid: `psid_${id}`,
                name: id
            }),
        error: null
    }));
    const contactsEq = vi.fn().mockReturnValue({ in: contactsIn });
    const contactsSelect = vi.fn().mockReturnValue({ eq: contactsEq });

    const outboundIn = vi.fn().mockResolvedValue({ data: [], error: null });
    const outboundEq = vi.fn().mockReturnValue({ in: outboundIn });
    const outboundSelect = vi.fn().mockReturnValue({ eq: outboundEq });

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

        if (table === 'outbound_message_events') {
            return { select: outboundSelect };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return { from, contactsIn, outboundIn };
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
        mocks.getPageConversationsBatch.mockResolvedValue({
            conversations: [
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
            ],
            nextCursor: 'cursor_2'
        });
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
            Number.MAX_SAFE_INTEGER,
            { throwOnError: true }
        );
        expect(body).toContain('senderType,sentBy,direction,messageSource,sourceName');
        expect(body).toContain('"message_1","contact_psid_1","Jane Contact","contact","Jane Contact","incoming","contact","Messenger contact"');
        expect(body).toContain('"message_2","fb_page_1","Study Page","page","Study Page","outgoing","facebook_page_untracked"');
        expect(body).toContain('"Hello, ""Jane""","2026-07-26T09:59:00.000Z"');
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

    it('adds exact app and automation attribution when a send event was recorded', async () => {
        const supabase = createSupabaseMock();
        supabase.outboundIn.mockResolvedValue({
            data: [{
                message_id: 'message_2',
                source_type: 'automation',
                source_id: 'automation_1',
                source_name: 'First reply follow-up',
                actor_user_id: null,
                actor_name: null,
                message_kind: 'HUMAN_AGENT'
            }],
            error: null
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await GET(createRequest('json'), {
            params: Promise.resolve({ pageId: 'page_1' })
        });
        const body = await response.json();

        expect(body.messages[1]).toEqual(expect.objectContaining({
            sentBy: 'Study Page',
            direction: 'outgoing',
            messageSource: 'automation',
            sourceName: 'First reply follow-up',
            sourceId: 'automation_1',
            messageKind: 'HUMAN_AGENT',
            sentAt: '2026-07-26T10:00:00.000Z'
        }));
    });

    it('exports whole-page conversations in resumable batches', async () => {
        const request = new Request(
            'http://localhost:3000/api/pages/page_1/conversations/export?format=csv&batched=true&batchSize=25&cursor=cursor_1'
        ) as unknown as NextRequest;
        const response = await GET(request, {
            params: Promise.resolve({ pageId: 'page_1' })
        });

        expect(response.status).toBe(200);
        expect(mocks.getPageConversations).not.toHaveBeenCalled();
        expect(mocks.getPageConversationsBatch).toHaveBeenCalledWith(
            'fb_page_1',
            'page_access_token_1',
            { limit: 25, after: 'cursor_1' }
        );
        expect(response.headers.get('x-export-next-cursor')).toBe('cursor_2');
        expect(response.headers.get('x-export-batch-complete')).toBe('false');
        expect(response.headers.get('x-export-conversation-count')).toBe('1');
        expect(response.headers.get('x-export-message-count')).toBe('2');
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
            'page_access_token_1',
            { throwOnError: true }
        );
        expect(mocks.getConversationMessages).toHaveBeenCalledWith(
            'conversation_1',
            'page_access_token_1',
            Number.MAX_SAFE_INTEGER,
            { throwOnError: true }
        );
        expect(body).toContain('"contact_psid_1","Jane Contact","message_1"');
        expect(body).toContain('"message_2","fb_page_1","Study Page","page","Study Page","outgoing","facebook_page_untracked"');
    });

    it('loads large selected exports in URL-safe query batches', async () => {
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        const contactIds = Array.from({ length: 205 }, (_, index) => `contact_${index + 1}`);

        const response = await POST(createPostRequest({
            format: 'csv',
            contactIds
        }), {
            params: Promise.resolve({ pageId: 'page_1' })
        });

        expect(response.status).toBe(200);
        expect(supabase.contactsIn).toHaveBeenCalledTimes(3);
        expect(supabase.contactsIn.mock.calls.map((call) => call[1].length)).toEqual([100, 100, 5]);
        expect(mocks.getConversationIdForPsid).toHaveBeenCalledTimes(205);
    });

    it('rejects oversized selected batches instead of silently truncating them', async () => {
        const contactIds = Array.from({ length: 101 }, (_, index) => `contact_${index + 1}`);
        const response = await POST(createPostRequest({
            format: 'csv',
            batched: true,
            contactIds
        }), {
            params: Promise.resolve({ pageId: 'page_1' })
        });

        expect(response.status).toBe(413);
        expect((await response.json()).message).toContain('at most 100');
        expect(mocks.getConversationIdForPsid).not.toHaveBeenCalled();
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
