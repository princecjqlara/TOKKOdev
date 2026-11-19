import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ session: vi.fn(), rpc: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: mocks.session }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ rpc: mocks.rpc }) }));
import { GET, PATCH } from './route';
const page = '10000000-0000-4000-8000-000000000001';
const params = { params: Promise.resolve({ pageId: page }) };
const request = (query = 'from=2026-01-01&to=2026-01-31') => new NextRequest('https://tokko.example/api/pages/' + page + '/insights?' + query);
beforeEach(() => { mocks.session.mockResolvedValue({ user: { id: 'actor' } });mocks.rpc.mockResolvedValue({ data: { episodes: { total: 0 } }, error: null }); });
afterEach(() => { vi.clearAllMocks(); });
describe('inquiry report access and filters', () => {
    it('requires a signed-in actor before querying data', async () => { mocks.session.mockResolvedValue(null);expect((await GET(request(), params)).status).toBe(401);expect(mocks.rpc).not.toHaveBeenCalled(); });
    it('passes the actual actor and fixed Page to the permission-checking RPC', async () => {
        const r = await GET(request(), params);expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toContain('no-store');
        expect(mocks.rpc).toHaveBeenCalledWith('tokko_inquiry_insights', { p_actor: 'actor', p_page: page, p_from: '2026-01-01', p_to: '2026-01-31', p_kind: 'all', p_horizon_hours: 24 });
    });
    it.each(['from=2026-02-30&to=2026-03-10', 'from=0000-00-00&to=2026-01-31', 'from=2026-02-01&to=2026-01-01', 'from=2020-01-01&to=2026-01-01', 'from=2026-01-01&to=2026-01-31&kind=someone-else', 'from=2026-01-01&to=2026-01-31&horizon=3'])('rejects invalid filters: %s', async query => { expect((await GET(request(query), params)).status).toBe(400);expect(mocks.rpc).not.toHaveBeenCalled(); });
    it('denies revoked Page membership and does not return internal errors', async () => { mocks.rpc.mockResolvedValue({ error: { code: '42501', message: 'private detail' } });const r = await GET(request(), params);expect(r.status).toBe(403);expect(JSON.stringify(await r.json())).not.toContain('private detail'); });
    it('reports database unavailability without a fabricated empty report', async () => { mocks.rpc.mockRejectedValue(Error('secret detail'));const r = await GET(request(), params);expect(r.status).toBe(503);expect(JSON.stringify(await r.json())).not.toContain('secret detail'); });
    it('protects settings against cross-origin mutation', async () => { const r = await PATCH(new NextRequest('https://tokko.example/api/pages/' + page + '/insights', { method: 'PATCH', headers: { origin: 'https://other.example' }, body: '{}' }), params);expect(r.status).toBe(403);expect(mocks.rpc).not.toHaveBeenCalled(); });
    it('uses the manager-checking settings function and leaves other Page settings alone', async () => { const r = await PATCH(new NextRequest('https://tokko.example/api/pages/' + page + '/insights', { method: 'PATCH', headers: { origin: 'https://tokko.example' }, body: JSON.stringify({ returning_after_days: 7, response_sla_minutes: 30 }) }), params);expect(r.status).toBe(200);expect(mocks.rpc).toHaveBeenCalledWith('tokko_set_inquiry_policy', { p_actor: 'actor', p_page: page, p_returning_days: 7, p_sla_minutes: 30 }); });
});
