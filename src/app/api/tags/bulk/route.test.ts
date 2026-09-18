import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    getSupabaseAdmin: vi.fn()
}));

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));
vi.mock('@/lib/activity-history', () => ({ recordPageActivity: vi.fn() }));

import { DELETE } from './route';

describe('DELETE /api/tags/bulk', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects a batch containing a default page tag before deleting assignments', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });
        const tagsDelete = vi.fn();
        const contactTagsDelete = vi.fn();
        const supabase = {
            from: vi.fn((table: string) => {
                if (table === 'tags') {
                    return {
                        select: vi.fn(() => ({
                            in: vi.fn().mockResolvedValue({ data: [{
                                id: 'default_tag', name: 'Paid / Availed Service', owner_type: 'page',
                                owner_id: 'page_1', page_id: 'page_1', is_default: true
                            }], error: null })
                        })),
                        delete: tagsDelete
                    };
                }
                if (table === 'user_pages') {
                    return { select: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({
                        data: [{ page_id: 'page_1' }], error: null
                    }) })) };
                }
                if (table === 'business_users') {
                    return { select: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) })) };
                }
                if (table === 'contact_tags') return { delete: contactTagsDelete };
                throw new Error(`Unexpected table: ${table}`);
            })
        };
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await DELETE(new Request('http://localhost:3000/api/tags/bulk', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tagIds: ['default_tag'] })
        }) as NextRequest);

        expect(response.status).toBe(400);
        expect(tagsDelete).not.toHaveBeenCalled();
        expect(contactTagsDelete).not.toHaveBeenCalled();
    });
});
