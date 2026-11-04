import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ session: vi.fn(), db: vi.fn(), templates: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: mocks.session }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.db }));
vi.mock('@/lib/facebook', () => ({ getPageTemplates: mocks.templates }));
import { POST } from '../../app/api/pages/[pageId]/automations/route';
import { PATCH } from '../../app/api/pages/[pageId]/automations/[automationId]/route';

const late = { message_text: 'Hi', delay_minutes: 8 * 1440 };
function request(body: unknown, method = 'POST') { return new NextRequest('https://tokko.example/api/pages/page_1/automations', {
    method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }
}); }
function fixture(options: { access?: boolean; steps?: unknown[] } = {}) {
    const writes: any[] = [];
    const db = { from: vi.fn((table: string) => {
        const chain: any = { select: () => chain, eq: () => chain,
            insert: (payload: any) => { writes.push(payload); return chain; },
            update: (payload: any) => { writes.push(payload); return chain; },
            single: async () => ({ data: table === 'user_pages' ? options.access === false ? null : { page_id: 'page_1' }
                : table === 'pages' ? { fb_page_id: 'facebook_1', access_token: 'token' }
                : { id: 'automation_1', steps: options.steps || [late] }, error: null }) };
        return chain;
    }) };
    mocks.db.mockReturnValue(db);
    return { db, writes };
}
beforeEach(() => {
    vi.clearAllMocks(); mocks.session.mockResolvedValue({ user: { id: 'user_1' } });
    mocks.templates.mockResolvedValue([{ name: 'chosen', status: 'APPROVED', category: 'UTILITY', language: 'en_US',
        components: [{ type: 'BODY', text: 'Hello {{1}}' }] }]);
});
describe('follow-up template requirements on save', () => {
    it.each(['POST', 'PATCH'])('rejects a late step without a user-selected template on %s', async method => {
        const { writes } = fixture();
        const req = request({ name: 'Follow-up', steps: [late] }, method);
        const response = method === 'POST' ? await POST(req, { params: Promise.resolve({ pageId: 'page_1' }) })
            : await PATCH(req, { params: Promise.resolve({ pageId: 'page_1', automationId: 'automation_1' }) });
        expect(response.status).toBe(400);
        expect((await response.json()).message).toContain('choose an approved template');
        expect(writes).toEqual([]);
        expect(mocks.templates).not.toHaveBeenCalled();
    });
    it('does not let Enable bypass the template requirement on an older saved workflow', async () => {
        const { writes } = fixture();
        const response = await PATCH(request({ enabled: true }, 'PATCH'), { params: Promise.resolve({ pageId: 'page_1', automationId: 'automation_1' }) });
        expect(response.status).toBe(400); expect(writes).toEqual([]);
    });
    it('saves the selected template, language, values, and delay without a seven-day clamp', async () => {
        const { writes } = fixture();
        const step = { ...late, template_name: 'chosen', template_language: 'en_US', template_parameters: ['{{first_name}}'] };
        const response = await POST(request({ name: 'Follow-up', steps: [step] }), { params: Promise.resolve({ pageId: 'page_1' }) });
        expect(response.status).toBe(201);
        expect(writes[0].steps).toMatchObject([step]);
        expect(mocks.templates).toHaveBeenCalledWith('facebook_1', 'token');
    });
    it('rejects unavailable templates and incomplete parameters before saving', async () => {
        const { writes } = fixture();
        for (const step of [{ ...late, template_name: 'other' }, { ...late, template_name: 'chosen', template_parameters: [] }]) {
            expect((await POST(request({ name: 'Follow-up', steps: [step] }), { params: Promise.resolve({ pageId: 'page_1' }) })).status).toBe(400);
        }
        expect(writes).toEqual([]);
    });
    it('checks Page access before reading its templates', async () => {
        const { writes } = fixture({ access: false });
        expect((await POST(request({ name: 'Follow-up', steps: [late] }), { params: Promise.resolve({ pageId: 'page_1' }) })).status).toBe(403);
        expect(mocks.templates).not.toHaveBeenCalled(); expect(writes).toEqual([]);
    });
});
