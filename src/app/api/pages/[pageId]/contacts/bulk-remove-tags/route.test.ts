import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    getSupabaseAdmin: vi.fn()
}));

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));

import { POST } from './route';

function createRequest(contactIds: string[], tagIds: string[]): NextRequest {
    return new Request('http://localhost:3000/api/pages/page_1/contacts/bulk-remove-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactIds, tagIds })
    }) as NextRequest;
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
    const contactsIn = vi.fn((_column: string, ids: string[]) => {
        pendingContactIds = ids;
        return { eq: contactsEqPage };
    });
    const contactsSelect = vi.fn().mockReturnValue({ in: contactsIn });

    let deleteContactIds: string[] = [];
    const deleteTagIn = vi.fn((_column: string, tagIds: string[]) => Promise.resolve({
        error: null,
        count: deleteContactIds.length * tagIds.length
    }));
    const deleteContactIn = vi.fn((_column: string, ids: string[]) => {
        deleteContactIds = ids;
        return { in: deleteTagIn };
    });
    const contactTagsDelete = vi.fn().mockReturnValue({ in: deleteContactIn });
    const activityInsert = vi.fn().mockResolvedValue({ error: null });

    const from = vi.fn((table: string) => {
        if (table === 'user_pages') return { select: userPageSelect };
        if (table === 'contacts') return { select: contactsSelect };
        if (table === 'contact_tags') return { delete: contactTagsDelete };
        if (table === 'page_activity_history') return { insert: activityInsert };
        throw new Error(`Unexpected table: ${table}`);
    });

    return { from, contactsIn, deleteContactIn, deleteTagIn };
}

describe('POST /api/pages/[pageId]/contacts/bulk-remove-tags', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });
    });

    it('batches large contact validation and tag removals', async () => {
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        const contactIds = Array.from({ length: 205 }, (_, index) => `contact_${index + 1}`);

        const response = await POST(createRequest(contactIds, ['tag_1', 'tag_2']), {
            params: Promise.resolve({ pageId: 'page_1' })
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.removedCount).toBe(410);
        expect(supabase.contactsIn.mock.calls.map((call) => call[1].length)).toEqual([100, 100, 5]);
        expect(supabase.deleteContactIn.mock.calls.map((call) => call[1].length)).toEqual([100, 100, 5]);
        expect(supabase.deleteTagIn).toHaveBeenCalledTimes(3);
    });
});
