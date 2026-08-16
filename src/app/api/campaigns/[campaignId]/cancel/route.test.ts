import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    rpc: vi.fn(),
    from: vi.fn(),
    campaignUpdate: vi.fn()
}));

vi.mock('next-auth', () => ({
    getServerSession: mocks.getServerSession
}));

vi.mock('@/lib/auth', () => ({ authOptions: {} }));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: () => ({ from: mocks.from, rpc: mocks.rpc })
}));

import { POST } from './route';

function singleQuery(data: unknown) {
    const single = vi.fn().mockResolvedValue({ data, error: null });
    const query: { eq: ReturnType<typeof vi.fn>; single: typeof single } = {
        eq: vi.fn(),
        single
    };
    query.eq.mockReturnValue(query);
    return { select: vi.fn().mockReturnValue(query) };
}

function campaignQuery(data: unknown) {
    const selectQuery = singleQuery(data);
    const pauseQuery: {
        eq: ReturnType<typeof vi.fn>;
        select: ReturnType<typeof vi.fn>;
        maybeSingle: ReturnType<typeof vi.fn>;
    } = {
        eq: vi.fn(),
        select: vi.fn(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'campaign_1' }, error: null })
    };
    pauseQuery.eq.mockReturnValue(pauseQuery);
    pauseQuery.select.mockReturnValue(pauseQuery);

    return {
        ...selectQuery,
        update: mocks.campaignUpdate.mockReturnValue(pauseQuery)
    };
}

function remainingRecipientsQuery(count: number) {
    const query: { eq: ReturnType<typeof vi.fn>; in: ReturnType<typeof vi.fn> } = {
        eq: vi.fn(),
        in: vi.fn().mockResolvedValue({ count, error: null })
    };
    query.eq.mockReturnValue(query);
    return { select: vi.fn().mockReturnValue(query) };
}

describe('POST /api/campaigns/[campaignId]/cancel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });
        mocks.from.mockImplementation((table: string) => {
            if (table === 'campaigns') {
                return campaignQuery({ id: 'campaign_1', page_id: 'page_1', status: 'sending' });
            }
            if (table === 'user_pages') {
                return singleQuery({ page_id: 'page_1' });
            }
            if (table === 'campaign_recipients') {
                return remainingRecipientsQuery(104371);
            }
            throw new Error(`Unexpected table: ${table}`);
        });
        mocks.rpc.mockResolvedValue({ data: 104371, error: null });
    });

    it('pauses delivery and preserves the remaining queue', async () => {
        const response = await POST(
            new Request('http://localhost/api/campaigns/campaign_1/cancel', { method: 'POST' }) as never,
            { params: Promise.resolve({ campaignId: 'campaign_1' }) }
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(mocks.campaignUpdate).toHaveBeenCalledWith(expect.objectContaining({
            status: 'draft',
            background_delivery_enabled: false
        }));
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(body).toEqual(expect.objectContaining({
            success: true,
            resumable: true,
            remainingRecipients: 104371
        }));
    });

    it('does not pause campaigns belonging to an inaccessible page', async () => {
        mocks.from.mockImplementation((table: string) => {
            if (table === 'campaigns') {
                return campaignQuery({ id: 'campaign_1', page_id: 'page_1', status: 'sending' });
            }
            if (table === 'user_pages') {
                return singleQuery(null);
            }
            throw new Error(`Unexpected table: ${table}`);
        });

        const response = await POST(
            new Request('http://localhost/api/campaigns/campaign_1/cancel', { method: 'POST' }) as never,
            { params: Promise.resolve({ campaignId: 'campaign_1' }) }
        );

        expect(response.status).toBe(403);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
});
