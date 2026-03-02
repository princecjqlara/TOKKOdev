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

import { GET } from './route';

function createRequest(): NextRequest {
    return new Request('http://localhost:3000/api/pages/page_1/team') as unknown as NextRequest;
}

function createSupabaseMock() {
    const accessSingle = vi.fn().mockResolvedValue({ data: { page_id: 'page_1' }, error: null });
    const accessEqPage = vi.fn().mockReturnValue({ single: accessSingle });
    const accessEqUser = vi.fn().mockReturnValue({ eq: accessEqPage });
    const accessSelect = vi.fn().mockReturnValue({ eq: accessEqUser });

    const membersEqPage = vi.fn().mockResolvedValue({
        data: [
            {
                user_id: 'user_1',
                users: {
                    id: 'user_1',
                    name: 'Owner',
                    email: 'owner@example.com'
                }
            },
            {
                user_id: 'user_2',
                users: {
                    id: 'user_2',
                    name: 'Teammate',
                    email: 'teammate@example.com'
                }
            }
        ],
        error: null
    });
    const membersSelect = vi.fn().mockReturnValue({ eq: membersEqPage });

    const from = vi.fn((table: string) => {
        if (table === 'user_pages') {
            if (from.mock.calls.length === 1) {
                return {
                    select: accessSelect
                };
            }

            return {
                select: membersSelect
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from
    };
}

describe('GET /api/pages/[pageId]/team', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns page team members and total count', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });
        mocks.getSupabaseAdmin.mockReturnValue(createSupabaseMock());

        const response = await GET(createRequest(), {
            params: Promise.resolve({ pageId: 'page_1' })
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.total).toBe(2);
        expect(body.members).toEqual([
            {
                id: 'user_1',
                name: 'Owner',
                email: 'owner@example.com'
            },
            {
                id: 'user_2',
                name: 'Teammate',
                email: 'teammate@example.com'
            }
        ]);
    });
});
