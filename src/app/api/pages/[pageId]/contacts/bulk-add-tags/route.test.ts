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

function createRequest(): NextRequest {
    return new Request('http://localhost:3000/api/pages/page_1/contacts/bulk-add-tags', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            contactIds: ['contact_1'],
            tagIds: ['tag_1']
        })
    }) as unknown as NextRequest;
}

function createSupabaseMock() {
    const userPageSingle = vi.fn().mockResolvedValue({ data: { page_id: 'page_1' }, error: null });
    const userPageEqPage = vi.fn().mockReturnValue({ single: userPageSingle });
    const userPageEqUser = vi.fn().mockReturnValue({ eq: userPageEqPage });
    const userPageSelect = vi.fn().mockReturnValue({ eq: userPageEqUser });

    const contactsEqPage = vi.fn().mockResolvedValue({ data: [{ id: 'contact_1' }], error: null });
    const contactsIn = vi.fn().mockReturnValue({ eq: contactsEqPage });
    const contactsSelect = vi.fn().mockReturnValue({ in: contactsIn });

    const upsert = vi.fn().mockResolvedValue({ error: null });

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

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        upsert
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
    });
});
