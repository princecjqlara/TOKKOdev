import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSupabaseAdmin: vi.fn(),
    verifyWebhookSignature: vi.fn(),
    generateVerifyToken: vi.fn(),
    sendMessage: vi.fn(),
    getUserProfile: vi.fn()
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/facebook', () => ({
    verifyWebhookSignature: mocks.verifyWebhookSignature,
    generateVerifyToken: mocks.generateVerifyToken,
    sendMessage: mocks.sendMessage,
    getUserProfile: mocks.getUserProfile
}));

vi.mock('@/lib/placeholders', () => ({
    replaceTemplateVariables: vi.fn((template: string) => template)
}));

import { POST } from './route';

function createWebhookRequest(payload?: Record<string, unknown>): NextRequest {
    const defaultPayload = {
        object: 'page',
        entry: [
            {
                id: 'fb_page_1',
                messaging: [
                    {
                        sender: { id: 'contact_psid_1' },
                        recipient: { id: 'fb_page_1' },
                        timestamp: 1700000000000,
                        message: { mid: 'mid.1', text: 'hello there' }
                    }
                ]
            }
        ]
    };

    return new Request('http://localhost:3000/api/facebook/webhook', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload ?? defaultPayload)
    }) as unknown as NextRequest;
}

function createSupabaseMock() {
    const pageSingle = vi.fn().mockResolvedValue({
        data: {
            id: 'page_row_1',
            access_token: 'page_access_token_1'
        },
        error: null
    });
    const pageEq = vi.fn().mockReturnValue({ single: pageSingle });
    const pageSelect = vi.fn().mockReturnValue({ eq: pageEq });

    const existingContactMaybeSingle = vi.fn().mockResolvedValue({
        data: null,
        error: null
    });
    const existingContactEqPsid = vi.fn().mockReturnValue({ maybeSingle: existingContactMaybeSingle });
    const existingContactEqPage = vi.fn().mockReturnValue({ eq: existingContactEqPsid });
    const contactsSelect = vi.fn().mockReturnValue({ eq: existingContactEqPage });

    const contactsUpsertSingle = vi.fn().mockResolvedValue({
        data: {
            id: 'contact_row_1',
            name: 'Jane Contact'
        },
        error: null
    });
    const contactsUpsertSelect = vi.fn().mockReturnValue({ single: contactsUpsertSingle });
    const contactsUpsert = vi.fn().mockReturnValue({ select: contactsUpsertSelect });

    const contactsUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const contactsUpdate = vi.fn().mockReturnValue({ eq: contactsUpdateEq });

    const welcomeSingle = vi.fn().mockResolvedValue({
        data: {
            enabled: false,
            message_text: '',
            buttons: []
        },
        error: null
    });
    const welcomeEq = vi.fn().mockReturnValue({ single: welcomeSingle });
    const welcomeSelect = vi.fn().mockReturnValue({ eq: welcomeEq });

    const interactionsInsert = vi.fn().mockResolvedValue({ error: null });
    const interactionsSelectEqFromContact = vi.fn().mockResolvedValue({
        data: [{ hour_of_day: 22 }],
        error: null
    });
    const interactionsSelectEqContact = vi.fn().mockReturnValue({ eq: interactionsSelectEqFromContact });
    const interactionsSelect = vi.fn().mockReturnValue({ eq: interactionsSelectEqContact });

    const from = vi.fn((table: string) => {
        if (table === 'pages') {
            return {
                select: pageSelect
            };
        }

        if (table === 'contacts') {
            return {
                select: contactsSelect,
                upsert: contactsUpsert,
                update: contactsUpdate
            };
        }

        if (table === 'welcome_messages') {
            return {
                select: welcomeSelect
            };
        }

        if (table === 'contact_interactions') {
            return {
                insert: interactionsInsert,
                select: interactionsSelect
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        contactsUpsert
    };
}

function createSupabaseMockWithFirstInteractionColumnFailure() {
    const pageSingle = vi.fn().mockResolvedValue({
        data: {
            id: 'page_row_1',
            access_token: 'page_access_token_1'
        },
        error: null
    });
    const pageEq = vi.fn().mockReturnValue({ single: pageSingle });
    const pageSelect = vi.fn().mockReturnValue({ eq: pageEq });

    const existingContactMaybeSingle = vi.fn().mockResolvedValue({
        data: null,
        error: null
    });
    const existingContactEqPsid = vi.fn().mockReturnValue({ maybeSingle: existingContactMaybeSingle });
    const existingContactEqPage = vi.fn().mockReturnValue({ eq: existingContactEqPsid });
    const contactsSelect = vi.fn().mockReturnValue({ eq: existingContactEqPage });

    const contactsUpsert = vi.fn()
        .mockReturnValueOnce({
            select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                    data: null,
                    error: {
                        message: "Could not find the 'first_interaction_at' column of 'contacts' in the schema cache"
                    }
                })
            })
        })
        .mockReturnValueOnce({
            select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                    data: {
                        id: 'contact_row_2',
                        name: 'Fallback Contact'
                    },
                    error: null
                })
            })
        });

    const contactsUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const contactsUpdate = vi.fn().mockReturnValue({ eq: contactsUpdateEq });

    const welcomeSingle = vi.fn().mockResolvedValue({
        data: {
            enabled: false,
            message_text: '',
            buttons: []
        },
        error: null
    });
    const welcomeEq = vi.fn().mockReturnValue({ single: welcomeSingle });
    const welcomeSelect = vi.fn().mockReturnValue({ eq: welcomeEq });

    const interactionsInsert = vi.fn().mockResolvedValue({ error: null });
    const interactionsSelectEqFromContact = vi.fn().mockResolvedValue({
        data: [{ hour_of_day: 22 }],
        error: null
    });
    const interactionsSelectEqContact = vi.fn().mockReturnValue({ eq: interactionsSelectEqFromContact });
    const interactionsSelect = vi.fn().mockReturnValue({ eq: interactionsSelectEqContact });

    const from = vi.fn((table: string) => {
        if (table === 'pages') {
            return {
                select: pageSelect
            };
        }

        if (table === 'contacts') {
            return {
                select: contactsSelect,
                upsert: contactsUpsert,
                update: contactsUpdate
            };
        }

        if (table === 'welcome_messages') {
            return {
                select: welcomeSelect
            };
        }

        if (table === 'contact_interactions') {
            return {
                insert: interactionsInsert,
                select: interactionsSelect
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        contactsUpsert
    };
}

function createSupabaseMockWithGenericUpsertFailure() {
    const pageSingle = vi.fn().mockResolvedValue({
        data: {
            id: 'page_row_1',
            access_token: 'page_access_token_1'
        },
        error: null
    });
    const pageEq = vi.fn().mockReturnValue({ single: pageSingle });
    const pageSelect = vi.fn().mockReturnValue({ eq: pageEq });

    const existingContactMaybeSingle = vi.fn().mockResolvedValue({
        data: null,
        error: null
    });
    const existingContactEqPsid = vi.fn().mockReturnValue({ maybeSingle: existingContactMaybeSingle });
    const existingContactEqPage = vi.fn().mockReturnValue({ eq: existingContactEqPsid });
    const contactsSelect = vi.fn().mockReturnValue({ eq: existingContactEqPage });

    const contactsUpsert = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
                data: null,
                error: {
                    message: 'insert/update failed due to transient database issue'
                }
            })
        })
    });

    const contactsInsert = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
                data: {
                    id: 'contact_row_inserted',
                    name: 'Broken Contact'
                },
                error: null
            })
        })
    });

    const contactsUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });

    const from = vi.fn((table: string) => {
        if (table === 'pages') {
            return {
                select: pageSelect
            };
        }

        if (table === 'contacts') {
            return {
                select: contactsSelect,
                upsert: contactsUpsert,
                insert: contactsInsert,
                update: contactsUpdate
            };
        }

        if (table === 'welcome_messages') {
            return {
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        single: vi.fn().mockResolvedValue({
                            data: {
                                enabled: false,
                                message_text: '',
                                buttons: []
                            },
                            error: null
                        })
                    })
                })
            };
        }

        if (table === 'contact_interactions') {
            return {
                insert: vi.fn().mockResolvedValue({ error: null }),
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        eq: vi.fn().mockResolvedValue({ data: [], error: null })
                    })
                })
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        contactsUpsert,
        contactsInsert
    };
}

describe('POST /api/facebook/webhook', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.NODE_ENV = 'test';
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('creates new contacts and enriches profile from Facebook on first inbound message', async () => {
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'Jane Contact',
            profile_pic: 'https://example.com/jane.jpg'
        });

        const response = await POST(createWebhookRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(mocks.getUserProfile).toHaveBeenCalledWith('contact_psid_1', 'page_access_token_1');

        expect(supabase.contactsUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                page_id: 'page_row_1',
                psid: 'contact_psid_1',
                name: 'Jane Contact',
                profile_pic: 'https://example.com/jane.jpg'
            }),
            {
                onConflict: 'page_id,psid'
            }
        );
    });

    it('retries contact upsert without first_interaction_at when schema is older', async () => {
        const supabase = createSupabaseMockWithFirstInteractionColumnFailure();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'Fallback Contact',
            profile_pic: 'https://example.com/fallback.jpg'
        });

        const response = await POST(createWebhookRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(supabase.contactsUpsert).toHaveBeenCalledTimes(2);

        const firstPayload = supabase.contactsUpsert.mock.calls[0][0] as Record<string, unknown>;
        const secondPayload = supabase.contactsUpsert.mock.calls[1][0] as Record<string, unknown>;

        expect(firstPayload).toHaveProperty('first_interaction_at');
        expect(secondPayload).not.toHaveProperty('first_interaction_at');
    });

    it('falls back to insert for new contact when upsert fails unexpectedly', async () => {
        const supabase = createSupabaseMockWithGenericUpsertFailure();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'Broken Contact',
            profile_pic: 'https://example.com/broken.jpg'
        });

        const response = await POST(createWebhookRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(supabase.contactsUpsert).toHaveBeenCalledTimes(1);
        expect(supabase.contactsInsert).toHaveBeenCalledTimes(1);
    });

    it('ingests inbound standby events so contacts appear without manual sync', async () => {
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'Standby Contact',
            profile_pic: 'https://example.com/standby.jpg'
        });

        const response = await POST(createWebhookRequest({
            object: 'page',
            entry: [
                {
                    id: 'fb_page_1',
                    standby: [
                        {
                            sender: { id: 'contact_psid_1' },
                            recipient: { id: 'fb_page_1' },
                            timestamp: 1700000000000,
                            message: { mid: 'mid.2', text: 'hi from standby' }
                        }
                    ]
                }
            ]
        }));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(mocks.getUserProfile).toHaveBeenCalledWith('contact_psid_1', 'page_access_token_1');
        expect(supabase.contactsUpsert).toHaveBeenCalledTimes(1);
    });
});
