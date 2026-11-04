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
    leaseAcquired?: boolean;
    leaseError?: { code?: string; message: string };
    autoTagEnabled?: boolean;
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
            last_synced_at: null,
            messaging_auto_tag_enabled: options?.autoTagEnabled ?? true
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
    const contactSingle = vi.fn().mockResolvedValue({ data: { id: 'contact_row_1', last_inbound_at: new Date().toISOString() }, error: null });
    const contactsSelectEq = vi.fn().mockReturnValue({ in: contactsSelectIn,
        eq: vi.fn().mockReturnValue({ maybeSingle: contactSingle, single: contactSingle }) });
    const contactsSelect = vi.fn().mockReturnValue({ eq: contactsSelectEq });
    const tagAssignments = vi.fn().mockResolvedValue({ error: null });
    const tagChain: any = { select: () => tagChain, eq: () => tagChain,
        then: (resolve: any) => Promise.resolve({ data: [
            { id: 'qualified_tag', name: 'Qualified', is_default: true },
            { id: 'converted_tag', name: 'Converted', is_default: true },
            { id: 'lost_tag', name: 'Lost', is_default: true },
            { id: 'unqualified_tag', name: 'Not Qualified', is_default: true }
        ], error: null }).then(resolve) };

    const from = vi.fn((table: string) => {
        if (table === 'tags') return tagChain;
        if (table === 'contact_tags') return { upsert: tagAssignments };
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
    const rpc = vi.fn((functionName: string) => Promise.resolve({
        data: functionName === 'acquire_page_sync_lease' ? options?.leaseAcquired ?? true : true,
        error: functionName === 'acquire_page_sync_lease' ? options?.leaseError ?? null : null
    }));

    return {
        from,
        rpc,
        contactsUpsert,
        tagAssignments,
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

    it.each([
        ['Lead stage set to Qualified', 'qualified_tag'],
        ['Lead stage set to Converted', 'converted_tag'],
        ['Lead stage set to Lost', 'lost_tag'],
        ['Lead stage set to Not Qualified', 'unqualified_tag'],
        ['You created an order for PHP 699.00. View: fb-pma://payments/orderdetails/?invoice_id=12345', 'converted_tag']
    ])('updates tags from fetched Messenger history: %s', async (text, tagId) => {
        const { POST } = await loadRoute();
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getPageConversationsBatch.mockResolvedValue({ conversations: [{ id: 'conversation_1',
            updated_time: '2026-04-07T02:00:00Z', participants: { data: [{ id: 'contact_psid_1', name: 'Jane Contact' }] }
        }], nextCursor: null });
        mocks.getConversationMessages.mockResolvedValue([{ id: 'system_event', from: { id: 'fb_page_1' },
            message: text, created_time: '2026-04-07T02:00:00Z' }]);

        const response = await POST(createRequest({ forceFullSync: true }), { params: Promise.resolve({ pageId: 'page_1' }) });

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ synced: 1, failed: 0, tagged: 1 });
        expect(supabase.tagAssignments).toHaveBeenCalledWith([{ contact_id: 'contact_row_1', tag_id: tagId }],
            { onConflict: 'contact_id,tag_id', ignoreDuplicates: true });
    });

    it('retains the checkpoint and reports a failed tag write for retry', async () => {
        const { POST } = await loadRoute();
        const supabase = createSupabaseMock();
        supabase.tagAssignments.mockResolvedValue({ error: { message: 'Tag write failed' } });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getPageConversationsBatch.mockResolvedValue({ conversations: [{ id: 'conversation_1',
            updated_time: '2026-04-07T02:00:00Z', participants: { data: [{ id: 'contact_psid_1', name: 'Jane Contact' }] }
        }], nextCursor: null });
        mocks.getConversationMessages.mockResolvedValue([{ id: 'system_event', from: { id: 'fb_page_1' },
            message: 'Lead stage set to Qualified', created_time: '2026-04-07T02:00:00Z' }]);

        const response = await POST(createRequest(), { params: Promise.resolve({ pageId: 'page_1' }) });

        expect(await response.json()).toMatchObject({ synced: 0, failed: 1 });
        expect(supabase.pageUpdateEq).not.toHaveBeenCalled();
    });

    it('allows a manual sync to skip auto-tagging without changing the Page setting', async () => {
        const { POST } = await loadRoute();
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getPageConversationsBatch.mockResolvedValue({ conversations: [{ id: 'conversation_1',
            updated_time: new Date().toISOString(), participants: { data: [{ id: 'contact_psid_1', name: 'Jane Contact' }] }
        }], nextCursor: null });
        mocks.getConversationMessages.mockResolvedValue([{ id: 'system_event', from: { id: 'fb_page_1' },
            message: 'Lead stage set to Lost', created_time: new Date().toISOString() }]);
        const response = await POST(createRequest({ autoTag: false }), { params: Promise.resolve({ pageId: 'page_1' }) });
        expect(await response.json()).toMatchObject({ synced: 1, failed: 0, tagged: 0 });
        expect(supabase.tagAssignments).not.toHaveBeenCalled();
    });

    it('does not tag customer-authored stage text or a Page with auto-tag disabled', async () => {
        const { POST } = await loadRoute();
        for (const autoTagEnabled of [true, false]) {
            const supabase = createSupabaseMock({ autoTagEnabled });
            mocks.getSupabaseAdmin.mockReturnValue(supabase);
            mocks.getPageConversationsBatch.mockResolvedValue({ conversations: [{ id: 'conversation_1',
                updated_time: '2026-04-07T02:00:00Z', participants: { data: [{ id: 'contact_psid_1', name: 'Jane Contact' }] }
            }], nextCursor: null });
            mocks.getConversationMessages.mockResolvedValue([{ id: 'system_event',
                from: { id: autoTagEnabled ? 'contact_psid_1' : 'fb_page_1' },
                message: 'Lead stage set to Qualified', created_time: '2026-04-07T02:00:00Z' }]);

            const response = await POST(createRequest(), { params: Promise.resolve({ pageId: 'page_1' }) });

            expect(await response.json()).toMatchObject({ synced: 1, failed: 0, tagged: 0 });
            expect(supabase.tagAssignments).not.toHaveBeenCalled();
        }
    });

    it('keeps saved contacts and the previous checkpoint when history checking fails', async () => {
        const { POST } = await loadRoute();
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getPageConversationsBatch.mockResolvedValue({ conversations: [{ id: 'conversation_1',
            updated_time: '2026-04-07T02:00:00Z', participants: { data: [{ id: 'contact_psid_1', name: 'Jane Contact' }] }
        }], nextCursor: null });
        mocks.getConversationMessages.mockRejectedValueOnce(new Error('Facebook history unavailable'));

        const response = await POST(createRequest(), { params: Promise.resolve({ pageId: 'page_1' }) });

        expect(await response.json()).toMatchObject({ synced: 0, failed: 1, syncHadFailures: true });
        expect(supabase.contactsUpsert).toHaveBeenCalledTimes(2);
        expect(supabase.pageUpdateEq).not.toHaveBeenCalled();
        expect(supabase.tagAssignments).not.toHaveBeenCalled();
    });

    it('does not advance the checkpoint if a previous cursor page failed', async () => {
        const { POST } = await loadRoute();
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest({ syncHadFailures: true }), { params: Promise.resolve({ pageId: 'page_1' }) });

        expect(await response.json()).toMatchObject({ synced: 0, failed: 0, syncHadFailures: true });
        expect(supabase.pageUpdateEq).not.toHaveBeenCalled();
    });

    it('keeps staff message echoes subscribed after a contact sync', async () => {
        const { POST } = await loadRoute();
        mocks.getSupabaseAdmin.mockReturnValue(createSupabaseMock());
        let fields = new Set(['messages', 'messaging_postbacks', 'message_echoes']);
        mocks.subscribePageToAppWebhook.mockImplementation(async (_pageId, _token, nextFields: string[]) => {
            fields = new Set(nextFields);
        });
        const response = await POST(createRequest(), { params: Promise.resolve({ pageId: 'page_1' }) });
        expect(response.status).toBe(200);
        expect(fields.has('message_echoes')).toBe(true);
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

    it('uses conversation message sender names when participant and profile names are placeholders', async () => {
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
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'MESSENGER CONTACT'
        });
        mocks.getConversationMessages.mockResolvedValue([
            {
                id: 'message_1',
                message: 'hello',
                from: { id: 'contact_psid_1', name: 'Real Sender Name' },
                created_time: '2026-04-07T02:00:00.000Z'
            }
        ]);
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
        expect(enrichedPayload.name).toBe('Real Sender Name');
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

    it('rejects an overlapping sync before fetching Facebook conversations', async () => {
        const { POST } = await loadRoute();
        const supabase = createSupabaseMock({ leaseAcquired: false });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(
            createRequest({ syncRunId: 'second-run' }),
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );

        expect(response.status).toBe(409);
        expect(mocks.getPageConversationsBatch).not.toHaveBeenCalled();
    });

    it('fails closed when the sync lease migration is not installed', async () => {
        const { POST } = await loadRoute();
        const supabase = createSupabaseMock({
            leaseError: {
                code: 'PGRST202',
                message: 'Could not find the function public.acquire_page_sync_lease'
            }
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(
            createRequest({ syncRunId: 'migration-missing-run' }),
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual(expect.objectContaining({
            error: 'Sync safety migration required'
        }));
        expect(mocks.getPageConversationsBatch).not.toHaveBeenCalled();
    });
});
