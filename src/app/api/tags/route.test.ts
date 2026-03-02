import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

type Row = Record<string, unknown>;

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

import { GET, POST } from './route';

function createRequest(url: string, init?: RequestInit): NextRequest {
    const request = new Request(url, init) as NextRequest & { nextUrl?: URL };
    request.nextUrl = new URL(url);
    return request;
}

function createFilterableQuery(rows: Row[]) {
    const filters: Array<(row: Row) => boolean> = [];
    const applyFilters = () => rows.filter((row) => filters.every((filter) => filter(row)));

    const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn((column: string, value: unknown) => {
            filters.push((row) => row[column] === value);
            return builder;
        }),
        in: vi.fn((column: string, values: unknown[]) => {
            filters.push((row) => values.includes(row[column]));
            return builder;
        }),
        neq: vi.fn((column: string, value: unknown) => {
            filters.push((row) => row[column] !== value);
            return builder;
        }),
        order: vi.fn(() => builder),
        range: vi.fn(() => {
            const data = applyFilters();
            return Promise.resolve({ data, error: null, count: data.length });
        }),
        single: vi.fn(() => {
            const data = applyFilters();
            return Promise.resolve({ data: data[0] ?? null, error: null });
        }),
        then: (resolve: (value: { data: Row[]; error: null; count: number }) => unknown) => {
            const data = applyFilters();
            return Promise.resolve({ data, error: null, count: data.length }).then(resolve);
        }
    };

    return builder;
}

function createSupabaseMockForGet(rowsByTable: Record<string, Row[]>) {
    return {
        from: vi.fn((table: string) => createFilterableQuery(rowsByTable[table] || []))
    };
}

function createSupabaseMockForPost() {
    const insert = vi.fn((values: Row) => ({
        select: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({
                data: {
                    id: 'tag_1',
                    created_at: '2026-01-01T00:00:00.000Z',
                    ...values
                },
                error: null
            })
        }))
    }));

    const tagSharesUpsert = vi.fn().mockResolvedValue({ error: null });

    return {
        insert,
        tagSharesUpsert,
        from: vi.fn((table: string) => {
            if (table === 'user_pages') {
                return createFilterableQuery([
                    { user_id: 'user_1', page_id: 'page_1' },
                    { user_id: 'user_2', page_id: 'page_1' },
                    { user_id: 'user_3', page_id: 'page_1' }
                ]);
            }

            if (table === 'tags') {
                return {
                    insert
                };
            }

            if (table === 'tag_shares') {
                return {
                    upsert: tagSharesUpsert
                };
            }

            throw new Error(`Unexpected table: ${table}`);
        })
    };
}

describe('GET /api/tags', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('includes shared personal tags from teammates on the same page', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });

        const supabase = createSupabaseMockForGet({
            user_pages: [{ user_id: 'user_1', page_id: 'page_1' }],
            business_users: [],
            tags: [
                {
                    id: 'tag_own',
                    name: 'My Personal Tag',
                    color: '#000000',
                    owner_type: 'user',
                    owner_id: 'user_1',
                    page_id: 'page_1',
                    is_shared: false,
                    created_at: '2026-01-01T00:00:00.000Z'
                },
                {
                    id: 'tag_page',
                    name: 'Page Tag',
                    color: '#111111',
                    owner_type: 'page',
                    owner_id: 'page_1',
                    page_id: 'page_1',
                    is_shared: false,
                    created_at: '2026-01-01T00:00:00.000Z'
                },
                {
                    id: 'tag_shared',
                    name: 'Shared Personal Tag',
                    color: '#222222',
                    owner_type: 'user',
                    owner_id: 'user_2',
                    page_id: 'page_1',
                    is_shared: true,
                    created_at: '2026-01-01T00:00:00.000Z'
                },
                {
                    id: 'tag_private',
                    name: 'Private Personal Tag',
                    color: '#333333',
                    owner_type: 'user',
                    owner_id: 'user_2',
                    page_id: 'page_1',
                    is_shared: false,
                    created_at: '2026-01-01T00:00:00.000Z'
                }
            ]
        });

        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await GET(
            createRequest('http://localhost:3000/api/tags?scope=all&page=1&pageSize=50&pageId=page_1')
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        const tagIds = body.items.map((tag: { id: string }) => tag.id);
        expect(tagIds).toContain('tag_shared');
        expect(tagIds).not.toContain('tag_private');
    });

    it('only includes teammate shared tags targeted to the current user', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });

        const supabase = createSupabaseMockForGet({
            user_pages: [{ user_id: 'user_1', page_id: 'page_1' }],
            business_users: [],
            tags: [
                {
                    id: 'tag_visible_targeted',
                    name: 'Visible Targeted',
                    color: '#000000',
                    owner_type: 'user',
                    owner_id: 'user_2',
                    page_id: 'page_1',
                    is_shared: true,
                    created_at: '2026-01-01T00:00:00.000Z'
                },
                {
                    id: 'tag_hidden_targeted',
                    name: 'Hidden Targeted',
                    color: '#111111',
                    owner_type: 'user',
                    owner_id: 'user_2',
                    page_id: 'page_1',
                    is_shared: true,
                    created_at: '2026-01-01T00:00:00.000Z'
                }
            ],
            tag_shares: [
                {
                    tag_id: 'tag_visible_targeted',
                    shared_with_user_id: 'user_1'
                },
                {
                    tag_id: 'tag_hidden_targeted',
                    shared_with_user_id: 'user_3'
                }
            ]
        });

        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await GET(
            createRequest('http://localhost:3000/api/tags?scope=all&page=1&pageSize=50&pageId=page_1')
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        const tagIds = body.items.map((tag: { id: string }) => tag.id);
        expect(tagIds).toContain('tag_visible_targeted');
        expect(tagIds).not.toContain('tag_hidden_targeted');
    });
});

describe('POST /api/tags', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('stores is_shared when creating a personal tag shared with page teammates', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });

        const supabase = createSupabaseMockForPost();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(
            createRequest('http://localhost:3000/api/tags', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: 'VIP Shared',
                    color: '#000000',
                    ownerType: 'user',
                    ownerId: 'user_1',
                    pageId: 'page_1',
                    isShared: true
                })
            })
        );

        expect(response.status).toBe(200);
        expect(supabase.insert).toHaveBeenCalledWith(
            expect.objectContaining({
                is_shared: true
            })
        );
    });

    it('stores selected share recipients when creating a shared personal tag', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });

        const supabase = createSupabaseMockForPost();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(
            createRequest('http://localhost:3000/api/tags', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: 'VIP Team Subset',
                    color: '#000000',
                    ownerType: 'user',
                    ownerId: 'user_1',
                    pageId: 'page_1',
                    isShared: true,
                    sharedWithUserIds: ['user_2', 'user_3']
                })
            })
        );

        expect(response.status).toBe(200);
        expect(supabase.tagSharesUpsert).toHaveBeenCalledWith(
            [
                { tag_id: 'tag_1', shared_with_user_id: 'user_2' },
                { tag_id: 'tag_1', shared_with_user_id: 'user_3' }
            ],
            {
                onConflict: 'tag_id,shared_with_user_id',
                ignoreDuplicates: true
            }
        );
    });
});
