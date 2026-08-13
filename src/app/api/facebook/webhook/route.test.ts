import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSupabaseAdmin: vi.fn(),
    verifyWebhookSignature: vi.fn(),
    generateVerifyToken: vi.fn(),
    sendMessage: vi.fn(),
    getUserProfile: vi.fn(),
    handleFollowUpWorkflowContactReply: vi.fn(),
    triggerReplyWorkflowAutomations: vi.fn(),
    stopWorkflowAutomationsFromPageMessage: vi.fn()
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

vi.mock('@/lib/workflow-automations', () => ({
    handleFollowUpWorkflowContactReply: mocks.handleFollowUpWorkflowContactReply,
    triggerReplyWorkflowAutomations: mocks.triggerReplyWorkflowAutomations,
    stopWorkflowAutomationsFromPageMessage: mocks.stopWorkflowAutomationsFromPageMessage
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

function createSupabaseMock(options?: {
    welcomeConfig?: {
        enabled: boolean;
        message_text: string;
        buttons: Array<{ type: string; text: string; url?: string; payload?: string }>;
    };
    existingContact?: {
        id: string;
        name?: string | null;
        profile_pic?: string | null;
    } | null;
}) {
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
        data: options?.existingContact ?? null,
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
        data: options?.welcomeConfig ?? {
            enabled: false,
            message_text: '',
            buttons: []
        },
        error: null
    });
    const welcomeEq = vi.fn().mockReturnValue({ single: welcomeSingle, maybeSingle: welcomeSingle });
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
    const welcomeEq = vi.fn().mockReturnValue({ single: welcomeSingle, maybeSingle: welcomeSingle });
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
                        }),
                        maybeSingle: vi.fn().mockResolvedValue({
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
        vi.stubEnv('NODE_ENV', 'test');
        mocks.handleFollowUpWorkflowContactReply.mockResolvedValue({
            checked: 0,
            scheduled: 0,
            continued: 0,
            reset: 0,
            sent: 0,
            stopped: 0,
            completed: 0,
            skipped: 0,
            errors: 0
        });
        mocks.triggerReplyWorkflowAutomations.mockResolvedValue({
            checked: 0,
            sent: 0,
            stopped: 0,
            skipped: 0,
            errors: 0
        });
        mocks.stopWorkflowAutomationsFromPageMessage.mockResolvedValue({
            checked: 0,
            stopped: 0,
            skipped: 0
        });
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

    it('refreshes existing contacts that are missing names', async () => {
        const supabase = createSupabaseMock({
            existingContact: {
                id: 'contact_row_1',
                name: null,
                profile_pic: null
            }
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'Recovered Contact Name',
            profile_pic: 'https://example.com/recovered.jpg'
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
                name: 'Recovered Contact Name',
                profile_pic: 'https://example.com/recovered.jpg'
            }),
            {
                onConflict: 'page_id,psid'
            }
        );
    });

    it('refreshes existing contacts that still have placeholder Unknown Name values', async () => {
        const supabase = createSupabaseMock({
            existingContact: {
                id: 'contact_row_1',
                name: 'Unknown Name',
                profile_pic: null
            }
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'Recovered Contact Name',
            profile_pic: 'https://example.com/recovered.jpg'
        });

        const response = await POST(createWebhookRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(mocks.getUserProfile).toHaveBeenCalledWith('contact_psid_1', 'page_access_token_1');

        const payload = supabase.contactsUpsert.mock.calls[0][0] as Record<string, unknown>;
        expect(payload.name).toBe('Recovered Contact Name');
        expect(payload.profile_pic).toBe('https://example.com/recovered.jpg');
    });

    it('clears existing Messenger Contact placeholders when no real name is available', async () => {
        const supabase = createSupabaseMock({
            existingContact: {
                id: 'contact_row_1',
                name: 'MESSENGER CONTACT',
                profile_pic: null
            }
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'MESSENGER CONTACT',
            profile_pic: 'https://example.com/recovered.jpg'
        });

        const response = await POST(createWebhookRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);

        const payload = supabase.contactsUpsert.mock.calls[0][0] as Record<string, unknown>;
        expect(payload.name).toBeNull();
        expect(payload.profile_pic).toBe('https://example.com/recovered.jpg');
    });

    it('uses webhook sender names when profile lookup only returns Messenger Contact', async () => {
        const supabase = createSupabaseMock({
            existingContact: {
                id: 'contact_row_1',
                name: null,
                profile_pic: null
            }
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'Messenger Contact',
            profile_pic: 'https://example.com/recovered.jpg'
        });

        const response = await POST(createWebhookRequest({
            object: 'page',
            entry: [
                {
                    id: 'fb_page_1',
                    messaging: [
                        {
                            sender: { id: 'contact_psid_1', name: 'Real Sender Name' },
                            recipient: { id: 'fb_page_1' },
                            timestamp: 1700000000000,
                            message: { mid: 'mid.1', text: 'hello there' }
                        }
                    ]
                }
            ]
        }));

        expect(response.status).toBe(200);
        const payload = supabase.contactsUpsert.mock.calls[0][0] as Record<string, unknown>;
        expect(payload.name).toBe('Real Sender Name');
        expect(payload.profile_pic).toBe('https://example.com/recovered.jpg');
    });

    it('does not persist placeholder UNKNOWN name values from profile fetch', async () => {
        const supabase = createSupabaseMock({
            existingContact: {
                id: 'contact_row_1',
                name: null,
                profile_pic: null
            }
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'UNKNOWN',
            profile_pic: 'https://example.com/recovered.jpg'
        });

        const response = await POST(createWebhookRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);

        const payload = supabase.contactsUpsert.mock.calls[0][0] as Record<string, unknown>;
        expect(payload).not.toHaveProperty('name');
        expect(payload.profile_pic).toBe('https://example.com/recovered.jpg');
    });

    it('constructs contact name from first_name and last_name when combined name is missing', async () => {
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            first_name: 'Maria',
            last_name: 'Santos',
            profile_pic: 'https://example.com/maria.jpg'
        });

        const response = await POST(createWebhookRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(mocks.getUserProfile).toHaveBeenCalledWith('contact_psid_1', 'page_access_token_1');

        const payload = supabase.contactsUpsert.mock.calls[0][0] as Record<string, unknown>;
        expect(payload.name).toBe('Maria Santos');
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

    it('sends welcome as RESPONSE with mapped buttons when welcome config has buttons', async () => {
        const supabase = createSupabaseMock({
            welcomeConfig: {
                enabled: true,
                message_text: 'Hi {first_name} handa ka na bang palakasin sales mo this month?',
                buttons: [
                    { type: 'URL', text: 'CLICK HERE!', url: 'https://meet.google.com/peh-jivc-tgx' },
                    { type: 'QUICK_REPLY', text: 'Talk to sales', payload: '' }
                ]
            }
        });
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
        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);

        const sendArgs = mocks.sendMessage.mock.calls[0];
        expect(sendArgs[0]).toBe('fb_page_1');
        expect(sendArgs[1]).toBe('page_access_token_1');
        expect(sendArgs[2]).toBe('contact_psid_1');
        expect(sendArgs[4]).toBe('RESPONSE');
        expect(sendArgs[8]).toEqual([
            { type: 'URL', text: 'CLICK HERE!', url: 'https://meet.google.com/peh-jivc-tgx' },
            { type: 'POSTBACK', text: 'Talk to sales', payload: 'Talk to sales' }
        ]);
    });

    it('sends text-only welcome as RESPONSE for a new contact', async () => {
        const supabase = createSupabaseMock({
            welcomeConfig: {
                enabled: true,
                message_text: 'Hi {first_name}! Welcome to our page.',
                buttons: []
            }
        });
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
        expect(mocks.sendMessage).toHaveBeenCalledTimes(1);

        const sendArgs = mocks.sendMessage.mock.calls[0];
        expect(sendArgs[3]).toBe('Hi {first_name}! Welcome to our page.');
        expect(sendArgs[4]).toBe('RESPONSE');
        expect(sendArgs[8]).toBeUndefined();
    });
});
