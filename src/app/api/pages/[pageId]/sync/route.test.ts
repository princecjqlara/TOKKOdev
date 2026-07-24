import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    getPageConversations: vi.fn(),
    getPageConversationsBatch: vi.fn(),
    getUserProfile: vi.fn(),
    getConversationMessages: vi.fn(),
    subscribePageToAppWebhook: vi.fn()
}));

vi.mock('@/lib/get-session', () => ({
    getSessionFromRequest: mocks.getSessionFromRequest
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/facebook', () => ({
    getPageConversations: mocks.getPageConversations,
    getPageConversationsBatch: mocks.getPageConversationsBatch,
    getUserProfile: mocks.getUserProfile,
    getConversationMessages: mocks.getConversationMessages,
    subscribePageToAppWebhook: mocks.subscribePageToAppWebhook
}));

function createRequest(body: Record<string, unknown> = {}): NextRequest {
    return new Request('http://localhost:3000/api/pages/page_1/sync', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    }) as NextRequest;
}

function createSupabaseMock(options?: {
    existingContacts?: Array<{ psid: string; name: string | null; profile_pic: string | null }>;
}) {
    const userPageSingle = vi.fn().mockResolvedValue({
        data: { page_id: 'page_1' },
        error: null
    });
    const userPageEqPage = vi.fn().mockReturnValue({ single: userPageSingle });
    const userPageEqUser = vi.fn().mockReturnValue({ eq: userPageEqPage });
    const userPageSelect = vi.fn().mockReturnValue({ eq: userPageEqUser });

    const pageSingle = vi.fn().mockResolvedValue({
        data: {
            fb_page_id: 'fb_page_1',
            access_token: 'page_access_token_1',
            last_synced_at: null
        },
        error: null
    });
    const pageEq = vi.fn().mockReturnValue({ single: pageSingle });
    const pageSelect = vi.fn().mockReturnValue({ eq: pageEq });
    const pageUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const pageUpdate = vi.fn().mockReturnValue({ eq: pageUpdateEq });

    const contactsUpsert = vi.fn().mockResolvedValue({ error: null });
    const contactsSelectIn = vi.fn().mockResolvedValue({
        data: options?.existingContacts ?? [
            {
                psid: 'contact_psid_1',
                name: 'Jane Contact',
                profile_pic: null
            }
        ],
        error: null
    });
    const contactsSelectEq = vi.fn().mockReturnValue({ in: contactsSelectIn });
    const contactsSelect = vi.fn().mockReturnValue({ eq: contactsSelectEq });

    const from = vi.fn((table: string) => {
        if (table === 'user_pages') {
            return {
                select: userPageSelect
            };
        }

        if (table === 'pages') {
            return {
                select: pageSelect,
                update: pageUpdate
            };
        }

        if (table === 'contacts') {
            return {
                select: contactsSelect,
                upsert: contactsUpsert
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        contactsUpsert,
        pageUpdateEq
    };
}

async function loadRoute() {
    vi.resetModules();
    return import('./route');
}

describe('POST /api/pages/[pageId]/sync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionFromRequest.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });
        mocks.subscribePageToAppWebhook.mockResolvedValue(undefined);
        mocks.getConversationMessages.mockResolvedValue([]);
        mocks.getPageConversationsBatch.mockResolvedValue({
            conversations: [],
            nextCursor: null
        });
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'UNKNOWN'
        });
    });

    it('persists participant names in the first basic contact upsert without mixing nameless rows', async () => {
        const { POST } = await loadRoute();
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getPageConversationsBatch.mockResolvedValue({
            conversations: [
                {
                    id: 'conversation_1',
                    updated_time: '2026-04-07T02:00:00.000Z',
                    participants: {
                        data: [
                            { id: 'fb_page_1', name: 'Test Page' },
                            { id: 'contact_psid_1', name: 'Jane Contact' }
                        ]
                    }
                },
                {
                    id: 'conversation_2',
                    updated_time: '2026-04-07T03:00:00.000Z',
                    participants: {
                        data: [
                            { id: 'fb_page_1', name: 'Test Page' },
                            { id: 'contact_psid_2', name: 'UNKNOWN' }
                        ]
                    }
                }
            ],
            nextCursor: null
        });

        const response = await POST(
            createRequest(),
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );

        expect(response.status).toBe(200);
        const basicNamedRows = supabase.contactsUpsert.mock.calls[0][0] as Array<Record<string, unknown>>;
        const basicNamelessRows = supabase.contactsUpsert.mock.calls[1][0] as Array<Record<string, unknown>>;

        expect(basicNamedRows).toHaveLength(1);
        expect(basicNamedRows[0]).toEqual(expect.objectContaining({
            page_id: 'page_1',
            psid: 'contact_psid_1',
            name: 'Jane Contact'
        }));
        expect(basicNamelessRows).toHaveLength(1);
        expect(basicNamelessRows[0]).toEqual(expect.objectContaining({
            page_id: 'page_1',
            psid: 'contact_psid_2'
        }));
        expect(basicNamelessRows[0]).not.toHaveProperty('name');
    });

    it('clears existing Messenger Contact placeholders during enrichment', async () => {
        const { POST } = await loadRoute();
        const supabase = createSupabaseMock({
            existingContacts: [
                {
                    psid: 'contact_psid_1',
                    name: 'MESSENGER CONTACT',
                    profile_pic: null
                }
            ]
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getPageConversationsBatch.mockResolvedValue({
            conversations: [
                {
                    id: 'conversation_1',
                    updated_time: '2026-04-07T02:00:00.000Z',
                    participants: {
                        data: [
                            { id: 'fb_page_1', name: 'Test Page' },
                            { id: 'contact_psid_1', name: 'MESSENGER CONTACT' }
                        ]
                    }
                }
            ],
            nextCursor: null
        });

        const response = await POST(
            createRequest(),
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );

        expect(response.status).toBe(200);
        const enrichedPayload = supabase.contactsUpsert.mock.calls[1][0] as Record<string, unknown>;
        expect(enrichedPayload.name).toBeNull();
    });

    it('returns a paged continuation cursor without updating the sync checkpoint', async () => {
        const { POST } = await loadRoute();
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getPageConversationsBatch.mockResolvedValue({
            conversations: [
                {
                    id: 'conversation_1',
                    updated_time: '2026-04-07T02:00:00.000Z',
                    participants: {
                        data: [
                            { id: 'fb_page_1', name: 'Test Page' },
                            { id: 'contact_psid_1', name: 'Jane Contact' }
                        ]
                    }
                }
            ],
            nextCursor: 'after_cursor_2'
        });

        const response = await POST(
            createRequest({ syncStartedAt: '2026-04-07T01:00:00.000Z' }),
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data).toEqual(expect.objectContaining({
            success: true,
            partial: true,
            cursor: 'after_cursor_2',
            nextCursor: 'after_cursor_2',
            syncStartedAt: '2026-04-07T01:00:00.000Z'
        }));
        expect(supabase.pageUpdateEq).not.toHaveBeenCalled();
    });
});
