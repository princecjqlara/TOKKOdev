import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    getSupabaseAdmin: vi.fn()
}));

vi.mock('next-auth', () => ({
    getServerSession: mocks.getServerSession
}));

vi.mock('@/lib/auth', () => ({
    authOptions: {}
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/tag-filters', () => ({
    buildNotInFilter: vi.fn(() => null)
}));

import { GET } from './route';

function createRequest(url: string): NextRequest {
    const request = new Request(url) as NextRequest & { nextUrl?: URL };
    request.nextUrl = new URL(url);
    return request;
}

function createSupabaseMock() {
    const userPageSingle = vi.fn().mockResolvedValue({ data: { page_id: 'page_1' }, error: null });
    const userPageEqPage = vi.fn().mockReturnValue({ single: userPageSingle });
    const userPageEqUser = vi.fn().mockReturnValue({ eq: userPageEqPage });
    const userPageSelect = vi.fn().mockReturnValue({ eq: userPageEqUser });

    const contactsRange = vi.fn().mockResolvedValue({
        data: [
            {
                id: 'contact_1',
                page_id: 'page_1',
                psid: 'psid_1',
                name: 'Contact A',
                created_at: '2026-01-01T00:00:00.000Z',
                updated_at: '2026-01-01T00:00:00.000Z',
                contact_tags: [
                    {
                        tag_id: 'tag_1',
                        created_by: 'user_2',
                        tags: {
                            id: 'tag_1',
                            name: 'VIP',
                            color: '#000000',
                            owner_type: 'user',
                            owner_id: 'user_2',
                            page_id: 'page_1',
                            created_at: '2026-01-01T00:00:00.000Z'
                        }
                    }
                ]
            }
        ],
        error: null,
        count: 1
    });

    const contactsBuilder = {
        eq: vi.fn(() => contactsBuilder),
        order: vi.fn(() => contactsBuilder),
        range: contactsRange
    };

    const contactsSelect = vi.fn(() => contactsBuilder);

    const usersIn = vi.fn().mockResolvedValue({
        data: [
            {
                id: 'user_2',
                name: 'Teammate A',
                email: 'teammate@example.com'
            }
        ],
        error: null
    });
    const usersSelect = vi.fn().mockReturnValue({ in: usersIn });

    const from = vi.fn((table: string) => {
        if (table === 'user_pages') {
            return {
                select: userPageSelect
            };
        }

        if (table === 'contacts') {
            return {
                select: contactsSelect
            };
        }

        if (table === 'users') {
            return {
                select: usersSelect
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from
    };
}

describe('GET /api/pages/[pageId]/contacts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('includes who added each tag in contact results', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });

        mocks.getSupabaseAdmin.mockReturnValue(createSupabaseMock());

        const response = await GET(
            createRequest('http://localhost:3000/api/pages/page_1/contacts?page=1&pageSize=25'),
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.items[0].tags[0].tagged_by_user_id).toBe('user_2');
        expect(body.items[0].tags[0].tagged_by_name).toBe('Teammate A');
    });
});
