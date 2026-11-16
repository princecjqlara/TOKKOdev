import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ session: vi.fn(), from: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: mocks.session }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: mocks.from }) }));
import { GET } from './route';

const context = { params: Promise.resolve({ campaignId: 'campaign' }) };
function database({ authorized = true, error = null as unknown, recurring = false } = {}) {
    const diagnostic = { kind: 'recipient_unavailable', category: 'recipient_unavailable', source: 'meta', code: 551, subcode: 1545041 };
    const query = {
        select: vi.fn(), eq: vi.fn(), gte: vi.fn(), order: vi.fn(), range: vi.fn(), single: vi.fn(),
        returns: vi.fn().mockResolvedValue({ data: [{ contact_id: 'contact', error_message: 'Vague provider response',
            diagnostic, contacts: { name: 'Client', psid: 'psid' } }], count: 1, error })
    };
    for (const method of [query.select, query.eq, query.gte, query.order, query.range]) method.mockReturnValue(query);
    const single = (data: unknown) => {
        const builder = { select: vi.fn(), eq: vi.fn(), single: vi.fn().mockResolvedValue({ data, error: null }) };
        builder.select.mockReturnValue(builder); builder.eq.mockReturnValue(builder); return builder;
    };
    mocks.from.mockImplementation((table: string) => {
        if (table === 'campaigns') return single({ page_id: 'page', status: 'completed', recipient_history_purged_at: null,
            recurrence: recurring ? 'daily' : 'none', started_at: '2026-11-17T00:00:00Z' });
        if (table === 'user_pages') return single(authorized ? { page_id: 'page' } : null);
        if (table === 'campaign_delivery_failures') return query;
        throw Error(`Unexpected table ${table}`);
    });
    return { query, diagnostic };
}

beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue({ user: { id: 'user' } }); });

describe('campaign failure details', () => {
    it('requires sign-in before accessing campaign data', async () => {
        mocks.session.mockResolvedValue(null);
        expect((await GET(new NextRequest('http://localhost/api/campaigns/campaign/recipients'), context)).status).toBe(401);
        expect(mocks.from).not.toHaveBeenCalled();
    });
    it('checks Page access before reading failure evidence', async () => {
        database({ authorized: false });
        expect((await GET(new NextRequest('http://localhost/api/campaigns/campaign/recipients'), context)).status).toBe(403);
        expect(mocks.from).not.toHaveBeenCalledWith('campaign_delivery_failures');
    });
    it('returns provider evidence with bounded pagination', async () => {
        const { query, diagnostic } = database();
        const response = await GET(new NextRequest('http://localhost/api/campaigns/campaign/recipients?page=-3&pageSize=100000'), context);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ total: 1, page: 1, pageSize: 100,
            items: [{ contactId: 'contact', contactName: 'Client', contactPsid: 'psid', diagnostic }] });
        expect(query.range).toHaveBeenCalledWith(0, 99);
    });
    it('reports a backend read failure instead of a successful empty report', async () => {
        database({ error: { message: 'Database unavailable' } });
        const response = await GET(new NextRequest('http://localhost/api/campaigns/campaign/recipients'), context);
        expect(response.status).toBe(500);
        expect(await response.json()).not.toHaveProperty('items');
    });
    it('keeps daily-cycle failure details aligned with this cycle’s totals', async () => {
        const { query } = database({ recurring: true });
        expect((await GET(new NextRequest('http://localhost/api/campaigns/campaign/recipients'), context)).status).toBe(200);
        expect(query.gte).toHaveBeenCalledWith('failed_at', '2026-11-17T00:00:00Z');
    });
});
