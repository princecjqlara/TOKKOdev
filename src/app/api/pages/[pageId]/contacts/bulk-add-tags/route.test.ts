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

import { POST } from './route';

function createRequest(body: Record<string, unknown> = {
    contactIds: ['contact_1'],
    tagIds: ['tag_1']
}): NextRequest {
    return new Request('http://localhost:3000/api/pages/page_1/contacts/bulk-add-tags', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    }) as unknown as NextRequest;
}

function createSupabaseMock() {
    const userPageSingle = vi.fn().mockResolvedValue({ data: { page_id: 'page_1' }, error: null });
    const userPageEqPage = vi.fn().mockReturnValue({ single: userPageSingle });
    const userPageEqUser = vi.fn().mockReturnValue({ eq: userPageEqPage });
    const userPageSelect = vi.fn().mockReturnValue({ eq: userPageEqUser });

    let pendingContactIds: string[] = [];
    const contactsEqPage = vi.fn(() => Promise.resolve({
        data: pendingContactIds.map((id) => ({ id })),
        error: null
    }));
    const contactsIn = vi.fn((_column: string, contactIds: string[]) => {
        pendingContactIds = contactIds;
        return { eq: contactsEqPage };
    });
    const contactsSelect = vi.fn().mockReturnValue({ in: contactsIn });

    const upsert = vi.fn().mockResolvedValue({ error: null });
    const activityInsert = vi.fn().mockResolvedValue({ error: null });

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

        if (table === 'contact_tags') {
            return {
                upsert
            };
        }

        if (table === 'page_activity_history') {
            return {
                insert: activityInsert
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        contactsIn,
        upsert,
        activityInsert
    };
}

describe('POST /api/pages/[pageId]/contacts/bulk-add-tags', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('records which user added each contact tag', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });

        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest(), {
            params: Promise.resolve({ pageId: 'page_1' })
        });

        expect(response.status).toBe(200);
        expect(supabase.upsert).toHaveBeenCalledWith(
            [
                {
                    contact_id: 'contact_1',
                    tag_id: 'tag_1',
                    created_by: 'user_1'
                }
            ],
            {
                onConflict: 'contact_id,tag_id',
                ignoreDuplicates: true
            }
        );
        expect(supabase.activityInsert).toHaveBeenCalledWith(
            expect.objectContaining({
                page_id: 'page_1',
                actor_user_id: 'user_1',
                action_type: 'bulk_tags_added',
                target_count: 1,
                success_count: 1
            })
        );
    });

    it('batches large contact validation and tag assignment writes', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        const contactIds = Array.from({ length: 300 }, (_, index) => `contact_${index + 1}`);

        const response = await POST(createRequest({
            contactIds,
            tagIds: ['tag_1', 'tag_2']
        }), {
            params: Promise.resolve({ pageId: 'page_1' })
        });

        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.addedCount).toBe(600);
        expect(supabase.contactsIn).toHaveBeenCalledTimes(3);
        expect(supabase.contactsIn.mock.calls.map((call) => call[1].length)).toEqual([100, 100, 100]);
        expect(supabase.upsert).toHaveBeenCalledTimes(2);
        expect(supabase.upsert.mock.calls.map((call) => call[0].length)).toEqual([500, 100]);
    });
});
