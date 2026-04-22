import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    buildNotInFilter: vi.fn()
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
    buildNotInFilter: mocks.buildNotInFilter
}));

import { GET } from './route';

function createRequest(url: string): NextRequest {
    const request = new Request(url) as NextRequest & { nextUrl?: URL };
    request.nextUrl = new URL(url);
    return request;
}

function createSupabaseMock(options?: {
    includeContactIds?: string[];
    excludeContactIds?: string[];
    contactsData?: Array<Record<string, unknown>>;
}) {
    const userPageSingle = vi.fn().mockResolvedValue({ data: { page_id: 'page_1' }, error: null });
    const userPageEqPage = vi.fn().mockReturnValue({ single: userPageSingle });
    const userPageEqUser = vi.fn().mockReturnValue({ eq: userPageEqPage });
    const userPageSelect = vi.fn().mockReturnValue({ eq: userPageEqUser });

    const contactsData = options?.contactsData ?? [
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
    ];

    const contactsRange = vi.fn().mockResolvedValue({
        data: contactsData,
        error: null,
        count: contactsData.length
    });

    const contactsBuilder = {
        eq: vi.fn(() => contactsBuilder),
        in: vi.fn(() => contactsBuilder),
        not: vi.fn(() => contactsBuilder),
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

    const includeContactIds = options?.includeContactIds ?? ['contact_1'];
    const excludeContactIds = options?.excludeContactIds ?? ['contact_2'];
    const contactTagsEq = vi.fn()
        .mockResolvedValueOnce({
            data: includeContactIds.map(contactId => ({ contact_id: contactId })),
            error: null
        })
        .mockResolvedValueOnce({
            data: excludeContactIds.map(contactId => ({ contact_id: contactId })),
            error: null
        });
    const contactTagsIn = vi.fn().mockReturnValue({ eq: contactTagsEq });
    const contactTagsSelect = vi.fn().mockReturnValue({ in: contactTagsIn });

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

        if (table === 'contact_tags') {
            return {
                select: contactTagsSelect
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        contactsIn: contactsBuilder.in,
        contactsNot: contactsBuilder.not,
        contactTagsIn,
        contactTagsEq
    };
}

describe('GET /api/pages/[pageId]/contacts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.buildNotInFilter.mockReturnValue(null);
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

    it('applies include and exclude tag filters together', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });

        mocks.buildNotInFilter.mockReturnValue('("contact_2")');
        const supabase = createSupabaseMock({
            includeContactIds: ['contact_1', 'contact_2'],
            excludeContactIds: ['contact_2']
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await GET(
            createRequest('http://localhost:3000/api/pages/page_1/contacts?page=1&pageSize=25&tagIds=tag_a,tag_b&excludeTagIds=tag_x'),
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );

        expect(response.status).toBe(200);
        expect(supabase.contactTagsIn).toHaveBeenNthCalledWith(1, 'tag_id', ['tag_a', 'tag_b']);
        expect(supabase.contactTagsIn).toHaveBeenNthCalledWith(2, 'tag_id', ['tag_x']);
        expect(supabase.contactTagsEq).toHaveBeenNthCalledWith(1, 'contacts.page_id', 'page_1');
        expect(supabase.contactTagsEq).toHaveBeenNthCalledWith(2, 'contacts.page_id', 'page_1');
        expect(supabase.contactsIn).toHaveBeenCalledWith('id', ['contact_1', 'contact_2']);
        expect(mocks.buildNotInFilter).toHaveBeenCalledWith(['contact_2']);
        expect(supabase.contactsNot).toHaveBeenCalledWith('id', 'in', '("contact_2")');
    });

    it('normalizes placeholder contact names out of the API response', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });

        mocks.getSupabaseAdmin.mockReturnValue(createSupabaseMock({
            contactsData: [
                {
                    id: 'contact_1',
                    page_id: 'page_1',
                    psid: 'psid_1',
                    name: 'UNKNOWN',
                    created_at: '2026-01-01T00:00:00.000Z',
                    updated_at: '2026-01-01T00:00:00.000Z',
                    contact_tags: []
                }
            ]
        }));

        const response = await GET(
            createRequest('http://localhost:3000/api/pages/page_1/contacts?page=1&pageSize=25'),
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.items[0].name).toBeNull();
    });
});
