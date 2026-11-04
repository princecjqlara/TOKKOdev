import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    autoTag: vi.fn()
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
vi.mock('@/lib/messaging-auto-tag-worker', () => ({ processOneMessagingAutoTagPage: mocks.autoTag }));

import { GET } from './route';

function createRequest(url: string): NextRequest {
    const request = new Request(url) as NextRequest;
    Object.defineProperty(request, 'nextUrl', {
        value: new URL(url)
    });
    return request;
}

function createSupabaseMock(options?: {
    includeContactIds?: string[];
    excludeContactIds?: string[];
    contactsData?: Array<Record<string, unknown>>;
    tagRows?: any[];
    tagError?: any;
    hasAccess?: boolean;
}) {
    const userPageSingle = vi.fn().mockResolvedValue({ data: options?.hasAccess === false ? null : { page_id: 'page_1' }, error: null });
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
                        is_shared: true,
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

    const contactsBuilder: any = {
        eq: vi.fn(() => contactsBuilder),
        in: vi.fn(() => contactsBuilder),
        is: vi.fn(() => contactsBuilder),
        not: vi.fn(() => contactsBuilder),
        neq: vi.fn(() => contactsBuilder),
        gte: vi.fn(() => contactsBuilder),
        lte: vi.fn(() => contactsBuilder),
        or: vi.fn(() => contactsBuilder),
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
    const tagFilterRows = [
        includeContactIds.map(contactId => ({ contact_id: contactId })),
        excludeContactIds.map(contactId => ({ contact_id: contactId }))
    ];
    let tagFilterIndex = -1;
    const contactTagsFilterQuery = {
        range: vi.fn((from: number, to: number) => Promise.resolve({
            data: (tagFilterRows[tagFilterIndex] || []).slice(from, to + 1),
            error: null
        }))
    };
    const contactTagsEq = vi.fn(() => {
        tagFilterIndex += 1;
        return contactTagsFilterQuery;
    });
    const contactTagsIn = vi.fn().mockReturnValue({ eq: contactTagsEq });
    const contactTagRows = options?.tagRows ?? contactsData.flatMap((contact) =>
        Array.isArray(contact.contact_tags)
            ? contact.contact_tags.map((tagRow) => ({
                contact_id: contact.id,
                ...(tagRow as Record<string, unknown>)
            }))
            : []
    );
    const tagRanges: number[][] = [], tagBatches: string[][] = [];
    const contactTagRowsIn = vi.fn((_: string, ids: string[]) => {
        tagBatches.push(ids);
        const chain: any = { order: () => chain, range: async (from: number, to: number) => {
            tagRanges.push([from, to]);
            return { data: contactTagRows.filter(row => ids.includes(row.contact_id)).slice(from, to + 1), error: options?.tagError || null };
        } };
        return chain;
    });
    const contactTagsSelect = vi.fn((columns: string) => {
        if (columns.includes('tag_id')) {
            return { in: contactTagRowsIn };
        }

        return { in: contactTagsIn };
    });

    const from = vi.fn((table: string) => {
        if (table === 'tags') return { select: () => ({ in: async (_column: string, ids: string[]) => ({
            data: ids.map(id => ({ id, owner_type: 'page', owner_id: 'page_1', page_id: 'page_1' })), error: null
        }) }) };
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
        contactsSelect,
        contactsEq: contactsBuilder.eq,
        contactsIn: contactsBuilder.in,
        contactsIs: contactsBuilder.is,
        contactsNot: contactsBuilder.not,
        contactsOr: contactsBuilder.or,
        contactsOrder: contactsBuilder.order,
        contactTagsIn,
        contactTagRowsIn,
        tagRanges, tagBatches,
        contactTagsEq
    };
}

describe('GET /api/pages/[pageId]/contacts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.autoTag.mockResolvedValue({ pages: 0, conversations: 0, tagged: 0 });
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
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('returns automatic tags saved by the scheduler without starting a new poll', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });
        const tagRows = [{ contact_id: 'contact_1', tag_id: 'converted', created_by: null,
            tags: { id: 'converted', name: 'Converted', owner_type: 'page', owner_id: 'page_1', page_id: 'page_1' } }];
        const db = createSupabaseMock({ tagRows }); mocks.getSupabaseAdmin.mockReturnValue(db);
        const response = await GET(createRequest('http://localhost:3000/api/pages/page_1/contacts?tagIds=converted'),
            { params: Promise.resolve({ pageId: 'page_1' }) });
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body.items[0].tags).toEqual([expect.objectContaining({ id: 'converted', name: 'Converted' })]);
        expect(body).not.toHaveProperty('autoTagRefresh');
        expect(mocks.autoTag).not.toHaveBeenCalled();
        expect(db.contactsIn).toHaveBeenCalledWith('included_tag_filter.tag_id', ['converted']);
    });

    it('keeps saved tags available independently of Messenger worker availability', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });
        mocks.getSupabaseAdmin.mockReturnValue(createSupabaseMock());
        mocks.autoTag.mockRejectedValue(new Error('Facebook history unavailable'));
        const response = await GET(createRequest('http://localhost:3000/api/pages/page_1/contacts'),
            { params: Promise.resolve({ pageId: 'page_1' }) });
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body.items[0].tags[0].name).toBe('VIP');
        expect(mocks.autoTag).not.toHaveBeenCalled();
    });

    it('does not return empty tag arrays as a successful response when the tag lookup fails', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });
        mocks.getSupabaseAdmin.mockReturnValue(createSupabaseMock({ tagError: { message: 'Tag lookup failed' } }));
        const response = await GET(createRequest('http://localhost:3000/api/pages/page_1/contacts'),
            { params: Promise.resolve({ pageId: 'page_1' }) });
        expect(response.status).toBe(500);
        expect(await response.json()).not.toHaveProperty('items');
    });

    it('reads all tag relations beyond the database row limit', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });
        const tagRows = Array.from({ length: 1001 }, (_, i) => ({ contact_id: 'contact_1', tag_id: `tag-${i}`,
            tags: { id: `tag-${i}`, name: `Tag ${i}`, owner_type: 'page', owner_id: 'page_1', page_id: 'page_1' } }));
        const db = createSupabaseMock({ tagRows }); mocks.getSupabaseAdmin.mockReturnValue(db);
        const body = await (await GET(createRequest('http://localhost:3000/api/pages/page_1/contacts'),
            { params: Promise.resolve({ pageId: 'page_1' }) })).json();
        expect(body.items[0].tags).toHaveLength(1001);
        expect(db.tagRanges).toEqual([[0, 999], [1000, 1999]]);
    });

    it('bounds contact ID filters when a large list of contacts is fetched', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });
        const db = createSupabaseMock({ contactsData: Array.from({ length: 205 }, (_, i) => ({ id: `contact-${i}` })), tagRows: [] });
        mocks.getSupabaseAdmin.mockReturnValue(db);
        const response = await GET(createRequest('http://localhost:3000/api/pages/page_1/contacts?pageSize=1000'),
            { params: Promise.resolve({ pageId: 'page_1' }) });
        expect(response.status).toBe(200);
        expect(db.tagBatches.map(ids => ids.length)).toEqual([100, 100, 5]);
    });

    it('returns multiple Page stage tags while protecting private and other-Page tags', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });
        const visible = ['Qualified', 'Not Qualified', 'Converted', 'Lost'];
        const tagRows = visible.map(name => ({ contact_id: 'contact_1', tag_id: name,
            tags: { id: name, name, owner_type: 'page', owner_id: 'page_1', page_id: 'page_1' } }));
        tagRows.push({ contact_id: 'contact_1', tag_id: 'private',
            tags: { id: 'private', name: 'Private', owner_type: 'user', owner_id: 'other-user', page_id: 'page_1' } },
        { contact_id: 'contact_1', tag_id: 'foreign',
            tags: { id: 'foreign', name: 'Other Page', owner_type: 'page', owner_id: 'page_2', page_id: 'page_2' } });
        mocks.getSupabaseAdmin.mockReturnValue(createSupabaseMock({ tagRows }));
        const body = await (await GET(createRequest('http://localhost:3000/api/pages/page_1/contacts'),
            { params: Promise.resolve({ pageId: 'page_1' }) })).json();
        expect(body.items[0].tags.map((tag: any) => tag.name)).toEqual(visible);
    });

    it.each([false, true])('skips Facebook tag polling for lightweight selection or unauthorized access: hasAccess=%s', async hasAccess => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });
        mocks.getSupabaseAdmin.mockReturnValue(createSupabaseMock({ hasAccess }));
        const response = await GET(createRequest(`http://localhost:3000/api/pages/page_1/contacts${hasAccess ? '?includeTags=false' : ''}`),
            { params: Promise.resolve({ pageId: 'page_1' }) });
        expect(response.status).toBe(hasAccess ? 200 : 403);
        expect(mocks.autoTag).not.toHaveBeenCalled();
    });

    it('returns the same existing contacts to two members of a shared Page without another sync', async () => {
        const supabase = createSupabaseMock({ contactsData: [{ id: 'shared_contact', page_id: 'page_1', psid: 'shared_psid',
            name: 'Shared Contact', contact_tags: [] }] });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        const results = [];
        for (const id of ['user_1', 'user_2']) {
            mocks.getServerSession.mockResolvedValue({ user: { id } });
            const response = await GET(createRequest('http://localhost:3000/api/pages/page_1/contacts'),
                { params: Promise.resolve({ pageId: 'page_1' }) });
            expect(response.status).toBe(200);
            results.push((await response.json()).items);
        }
        expect(results[0]).toEqual(results[1]);
        expect(results[0]).toMatchObject([{ id: 'shared_contact' }]);
        expect(supabase.contactsEq.mock.calls).toEqual([['page_id', 'page_1'], ['page_id', 'page_1']]);
    });

    it('applies include and exclude tag filters together', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });

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
        expect(supabase.contactsSelect).toHaveBeenCalledWith(
            '*,included_tag_filter:contact_tags!inner(),excluded_tag_filter:contact_tags!left()',
            { count: 'exact' }
        );
        expect(supabase.contactsIn).toHaveBeenNthCalledWith(1, 'included_tag_filter.tag_id', ['tag_a', 'tag_b']);
        expect(supabase.contactsIn).toHaveBeenNthCalledWith(2, 'excluded_tag_filter.tag_id', ['tag_x']);
        expect(supabase.contactsIs).toHaveBeenCalledWith('excluded_tag_filter', null);
    });

    it('applies exclude mode to date filters', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });

        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await GET(
            createRequest('http://localhost:3000/api/pages/page_1/contacts?page=1&pageSize=25&dateFrom=2026-07-20&dateTo=2026-07-26&dateFilterMode=exclude'),
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );

        expect(response.status).toBe(200);
        expect(supabase.contactsOr).toHaveBeenCalledWith(
            'first_interaction_at.lt.2026-07-20,and(first_interaction_at.is.null,created_at.lt.2026-07-20),first_interaction_at.gte.2026-07-27,and(first_interaction_at.is.null,created_at.gte.2026-07-27)'
        );
    });

    it('sorts 7-day contacts by expiry, latest message, or name', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });

        for (const [sort, expectedColumn, expectedAscending] of [
            ['expiring', 'last_inbound_at', true],
            ['latest', 'last_inbound_at', false],
            ['name_asc', 'name', true],
            ['name_desc', 'name', false]
        ] as const) {
            const supabase = createSupabaseMock();
            mocks.getSupabaseAdmin.mockReturnValue(supabase);
            const response = await GET(
                createRequest(`http://localhost:3000/api/pages/page_1/contacts?humanAgentWindow=true&sort=${sort}`),
                { params: Promise.resolve({ pageId: 'page_1' }) }
            );
            expect(response.status).toBe(200);
            expect(supabase.contactsOrder).toHaveBeenCalledWith(expectedColumn, {
                ascending: expectedAscending,
                nullsFirst: false
            });
        }
    });

    it('can skip tag hydration for cross-page contact selection', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await GET(
            createRequest('http://localhost:3000/api/pages/page_1/contacts?humanAgentWindow=true&includeTags=false&includeCount=false&pageSize=1000'),
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );

        expect(response.status).toBe(200);
        expect(supabase.contactTagRowsIn).not.toHaveBeenCalled();
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
                    name: 'Unknown Name',
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
