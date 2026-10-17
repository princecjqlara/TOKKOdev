import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    session: vi.fn(), admin: vi.fn(), templates: vi.fn(), fetch: vi.fn()
}));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: mocks.session }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.admin }));
vi.mock('@/lib/facebook', async () => {
    const { UTILITY_TEMPLATES } = await import('@/lib/facebook-templates');
    return { getPageTemplates: mocks.templates, UTILITY_TEMPLATES };
});

import { POST } from './route';
import { TEMPLATE_CANDIDATES } from '@/lib/facebook-template-candidates';

function request(body: object) {
    return new NextRequest('http://localhost/api/facebook/templates/submit-all', {
        method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }
    });
}

beforeEach(() => {
    vi.resetAllMocks();
    mocks.session.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.templates.mockResolvedValue([]);
    const chain = {
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { page_id: 'page-1', fb_page_id: 'fb-1', access_token: 'test-token' } })
    };
    mocks.admin.mockReturnValue({ from: vi.fn().mockReturnValue(chain) });
    vi.stubGlobal('fetch', mocks.fetch);
});

describe('candidate review submission', () => {
    it('requires authentication', async () => {
        mocks.session.mockResolvedValue(null);
        expect((await POST(request({ pageId: 'page-1', catalog: 'candidates' }))).status).toBe(401);
        expect(mocks.admin).not.toHaveBeenCalled();
    });

    it('requires an explicit bounded selection of known text candidates', async () => {
        for (const body of [
            {}, { templateNames: [] }, { templateNames: ['unknown'] },
            { templateNames: TEMPLATE_CANDIDATES.slice(0, 26).map(t => t.name) },
            { templateNames: [TEMPLATE_CANDIDATES[0].name], mediaVariant: true }
        ]) {
            const response = await POST(request({ pageId: 'page-1', catalog: 'candidates', ...body }));
            expect(response.status).toBe(400);
        }
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('fails before submission when current page statuses cannot be checked', async () => {
        mocks.templates.mockRejectedValue(new Error('Temporary Facebook outage'));
        const response = await POST(request({ pageId: 'page-1', catalog: 'candidates', templateNames: [TEMPLATE_CANDIDATES[0].name] }));
        expect(response.status).toBe(502);
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('submits only selected candidates and excludes local metadata', async () => {
        mocks.fetch.mockResolvedValue({ ok: true, json: async () => [{ code: 200, body: JSON.stringify({ id: 'new-1', status: 'PENDING' }) }] });
        const candidate = TEMPLATE_CANDIDATES[0];
        const response = await POST(request({ pageId: 'page-1', catalog: 'candidates', templateNames: [candidate.name] }));
        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload.results).toEqual([expect.objectContaining({ name: candidate.name, status: 'PENDING', action: 'created' })]);
        expect(payload.summary.approved).toBe(0);
        const batch = JSON.parse(mocks.fetch.mock.calls[0][1].body.get('batch'));
        expect(batch).toHaveLength(1);
        const fields = new URLSearchParams(batch[0].body);
        expect([...fields.keys()].sort()).toEqual(['category', 'components', 'language', 'name']);
        expect(JSON.parse(fields.get('components')!)).toEqual(candidate.components);
    });

    it('keeps rejected or pending existing candidates and does not resubmit them', async () => {
        mocks.templates.mockResolvedValue([{ name: TEMPLATE_CANDIDATES[0].name, status: 'REJECTED', language: 'en_US' }]);
        const response = await POST(request({ pageId: 'page-1', catalog: 'candidates', templateNames: [TEMPLATE_CANDIDATES[0].name] }));
        const payload = await response.json();
        expect(payload.summary.approved).toBe(0);
        expect(payload.results[0]).toMatchObject({ action: 'already_exists', status: 'REJECTED' });
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('reviews a larger selection in batches of at most five', async () => {
        mocks.fetch.mockImplementation(async (_url: string, init: { body: URLSearchParams }) => ({
            ok: true,
            json: async () => JSON.parse(init.body.get('batch')!).map(() => ({
                code: 200, body: JSON.stringify({ status: 'PENDING' })
            }))
        }));
        const candidates = TEMPLATE_CANDIDATES.slice(0, 6);
        const response = await POST(request({ pageId: 'page-1', catalog: 'candidates', limit: 25, templateNames: candidates.map(t => t.name) }));
        const payload = await response.json();
        expect(payload.results).toHaveLength(6);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        expect(mocks.fetch.mock.calls.map(call => JSON.parse(call[1].body.get('batch')).length)).toEqual([5, 1]);
    });

    it('reports incomplete Facebook responses as errors instead of silently losing candidates', async () => {
        mocks.fetch.mockResolvedValue({ ok: true, json: async () => [] });
        const response = await POST(request({ pageId: 'page-1', catalog: 'candidates', templateNames: [TEMPLATE_CANDIDATES[0].name] }));
        const payload = await response.json();
        expect(payload.summary.errors).toBe(1);
        expect(payload.results[0]).toMatchObject({ action: 'error', status: 'ERROR' });
        expect(payload.results[0].error).toContain('incomplete batch');
    });
});
