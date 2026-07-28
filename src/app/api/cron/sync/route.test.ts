import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSupabaseAdmin: vi.fn(),
    getPageConversations: vi.fn(),
    getUserProfile: vi.fn(),
    repairMissingContactNamesForPage: vi.fn()
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/facebook', () => ({
    getPageConversations: mocks.getPageConversations,
    getUserProfile: mocks.getUserProfile
}));

vi.mock('../../../../lib/contact-name-repair', () => ({
    repairMissingContactNamesForPage: mocks.repairMissingContactNamesForPage
}));

function createRequest(): NextRequest {
    return new Request('http://localhost:3000/api/cron/sync', {
        method: 'GET'
    }) as NextRequest;
}

function createSupabaseMock() {
    const pagesSelect = vi.fn().mockResolvedValue({
        data: [
            {
                id: 'page_1',
                fb_page_id: 'fb_page_1',
                access_token: 'page_access_token_1',
                name: 'Test Page'
            }
        ],
        error: null
    });

    const contactsUpsert = vi.fn().mockResolvedValue({ error: null });

    const from = vi.fn((table: string) => {
        if (table === 'pages') {
            return {
                select: pagesSelect
            };
        }

        if (table === 'contacts') {
            return {
                upsert: contactsUpsert
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        contactsUpsert
    };
}

async function loadRoute() {
    vi.resetModules();
    return import('./route');
}

describe('GET /api/cron/sync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        mocks.repairMissingContactNamesForPage.mockResolvedValue({
            checked: 0,
            repaired: 0,
            cleared: 0,
            failed: 0
        });
    });

    it('keeps the participant name when profile lookup returns placeholder UNKNOWN', async () => {
        const { GET } = await loadRoute();
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getPageConversations.mockResolvedValue([
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
        ]);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'UNKNOWN',
            profile_pic: 'https://example.com/jane.jpg'
        });

        const response = await GET(createRequest());

        expect(response.status).toBe(200);
        expect(mocks.getPageConversations).toHaveBeenCalledWith(
            'fb_page_1',
            'page_access_token_1',
            50,
            false
        );
        expect(mocks.repairMissingContactNamesForPage).toHaveBeenCalledWith(
            supabase,
            expect.objectContaining({ id: 'page_1' }),
            { limit: 200 }
        );
        const payload = supabase.contactsUpsert.mock.calls[0][0] as Record<string, unknown>;
        expect(payload.name).toBe('Jane Contact');
        expect(payload.profile_pic).toBe('https://example.com/jane.jpg');
    });

    it('omits placeholder names when no usable contact name is available', async () => {
        const { GET } = await loadRoute();
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getPageConversations.mockResolvedValue([
            {
                id: 'conversation_1',
                updated_time: '2026-04-07T02:00:00.000Z',
                participants: {
                    data: [
                        { id: 'fb_page_1', name: 'Test Page' },
                        { id: 'contact_psid_1', name: 'UNKNOWN' }
                    ]
                }
            }
        ]);
        mocks.getUserProfile.mockResolvedValue({
            id: 'contact_psid_1',
            name: 'UNKNOWN',
            profile_pic: 'https://example.com/unknown.jpg'
        });

        const response = await GET(createRequest());

        expect(response.status).toBe(200);
        const payload = supabase.contactsUpsert.mock.calls[0][0] as Record<string, unknown>;
        expect(payload).not.toHaveProperty('name');
        expect(payload.profile_pic).toBe('https://example.com/unknown.jpg');
    });
});
