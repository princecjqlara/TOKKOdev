import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { AccessError } from '@/lib/account-security';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    subscribePageToAppWebhook: vi.fn(),
    getPageTemplates: vi.fn(),
    createUtilityTemplate: vi.fn(),
    verifiedFacebookPages: vi.fn()
}));
vi.mock('@/lib/page-managers', () => ({ verifiedFacebookPages: mocks.verifiedFacebookPages }));

vi.mock('@/lib/get-session', () => ({
    getSessionFromRequest: mocks.getSessionFromRequest
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/facebook', () => ({
    subscribePageToAppWebhook: mocks.subscribePageToAppWebhook,
    getPageTemplates: mocks.getPageTemplates,
    createUtilityTemplate: mocks.createUtilityTemplate
}));

vi.mock('@/lib/facebook-templates', () => ({
    UTILITY_TEMPLATES: []
}));

import { POST } from './route';

function createRequest(extra: Record<string, unknown> = {}): NextRequest {
    return new Request('http://localhost:3000/api/facebook/connect', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            fbPageId: 'fb_page_1',
            name: 'My Page',
            accessToken: 'page_access_token_1',
            ...extra
        })
    }) as unknown as NextRequest;
}

function createSupabaseMock(options: { lastSyncedAt?: string | null; hasContacts?: boolean; assigned?: boolean; accessError?: any;
    shared?: boolean; concurrentInsert?: boolean; pageReadError?: any; grantError?: any } = {}) {
    const sharedRow = { id: 'page_row_1',
        last_synced_at: options.lastSyncedAt === undefined ? '2026-11-01T00:00:00Z' : options.lastSyncedAt };
    const pageSelectSingle = vi.fn().mockResolvedValue({ data: sharedRow, error: null });
    const pageInsertSingle = vi.fn().mockResolvedValue({ data: options.concurrentInsert ? null : sharedRow, error: null });
    const pageUpsert = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: pageSelectSingle, maybeSingle: pageInsertSingle }) });
    const pageLookupFilters: any[] = [];
    let pageLookups = 0;
    const pageLookup = { eq: (key: string, value: string) => { pageLookupFilters.push([key, value]); return { maybeSingle: async () => {
        pageLookups++;
        return { data: options.shared || (options.concurrentInsert && pageLookups > 1) ? sharedRow : null, error: options.pageReadError || null };
    } }; } };

    const userPagesUpsert = vi.fn().mockResolvedValue({ error: options.grantError || null });
    const membershipFilters: any[] = [];
    const membershipQuery: any = { eq: (key: string, value: string) => { membershipFilters.push([key, value]); return membershipQuery; },
        maybeSingle: async () => ({ data: options.assigned && membershipFilters.some(([key, value]) => key === 'pages.fb_page_id' && value === 'fb_page_1')
            ? { page_id: 'page_row_1', pages: { id: 'page_row_1', fb_page_id: 'fb_page_1' } } : null, error: options.accessError || null }) };

    const from = vi.fn((table: string) => {
        if (table === 'pages') {
            return {
                upsert: pageUpsert, select: () => pageLookup
            };
        }

        if (table === 'user_pages') {
            return {
                select: () => membershipQuery,
                upsert: userPagesUpsert
            };
        }
        if (table === 'contacts') return { select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({
            data: options.hasContacts ? { id: 'shared_contact' } : null, error: null
        }) }) }) }) };

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        pageUpsert,
        pageLookupFilters,
        membershipFilters,
        userPagesUpsert
    };
}

describe('POST /api/facebook/connect', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getPageTemplates.mockResolvedValue([]);
        mocks.verifiedFacebookPages.mockResolvedValue([{ id: 'fb_page_1', name: 'My Page', access_token: 'page_access_token_1', tasks: ['MANAGE'] }]);
    });

    it('saves the fresh page token and subscribes the page to webhook events', async () => {
        const supabase = createSupabaseMock();

        mocks.getSessionFromRequest.mockResolvedValue({
            user: {
                id: 'user_1',
                email: 'user@example.com'
            }
        });
        mocks.subscribePageToAppWebhook.mockResolvedValue(undefined);
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(mocks.subscribePageToAppWebhook).toHaveBeenCalledWith(
            'fb_page_1',
            'page_access_token_1',
            ['messages', 'messaging_postbacks', 'message_echoes']
        );
        expect(supabase.from).toHaveBeenCalledWith('pages');
        expect(supabase.from).toHaveBeenCalledWith('user_pages');
        expect(supabase.userPagesUpsert.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.subscribePageToAppWebhook.mock.invocationCallOrder[0]
        );
    });

    it('rejects a client-supplied token when Facebook management is not verified', async () => {
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'member', provider: 'credentials' } });
        mocks.verifiedFacebookPages.mockRejectedValue(new AccessError(403, 'Facebook manager required.'));
        const response = await POST(createRequest());
        expect(response.status).toBe(403);
        expect(supabase.pageUpsert).not.toHaveBeenCalled();
        expect(supabase.userPagesUpsert).not.toHaveBeenCalled();
        expect(mocks.subscribePageToAppWebhook).not.toHaveBeenCalled();
    });

    it.each(['credentials', 'facebook'])('opens an assigned Page without a Facebook manager role or new sync: %s', async provider => {
        const supabase = createSupabaseMock({ assigned: true }); mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'invited_member', provider } });
        mocks.verifiedFacebookPages.mockRejectedValue(new AccessError(403, 'No Meta management role'));
        const response = await POST(createRequest());
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body).toMatchObject({ pageId: 'page_row_1', needsInitialSync: false, reusedConnection: true });
        expect(JSON.stringify(body)).not.toContain('access_token');
        expect(supabase.membershipFilters).toEqual([['user_id', 'invited_member'], ['pages.fb_page_id', 'fb_page_1']]);
        expect(mocks.verifiedFacebookPages).not.toHaveBeenCalled();
        expect(supabase.pageUpsert).not.toHaveBeenCalled();
        expect(supabase.userPagesUpsert).not.toHaveBeenCalled();
        expect(mocks.subscribePageToAppWebhook).not.toHaveBeenCalled();
        expect(mocks.createUtilityTemplate).not.toHaveBeenCalled();
    });

    it('does not let a team assignment overwrite the shared Facebook token on explicit refresh', async () => {
        const supabase = createSupabaseMock({ assigned: true }); mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'member', provider: 'facebook' } });
        mocks.verifiedFacebookPages.mockResolvedValue([]);
        const response = await POST(createRequest({ refreshConnection: true }));
        expect(response.status).toBe(403);
        expect((await response.json()).message).toContain('already assigned');
        expect(supabase.pageUpsert).not.toHaveBeenCalled();
        expect(mocks.subscribePageToAppWebhook).not.toHaveBeenCalled();
    });

    it.each(['PROFILE_PLUS_MANAGE', 'PROFILE_PLUS_FULL_CONTROL'])('allows a verified manager to connect using %s', async task => {
        const supabase = createSupabaseMock(); mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'manager', provider: 'facebook' } });
        mocks.verifiedFacebookPages.mockResolvedValue([{ id: 'fb_page_1', name: 'New Page', access_token: 'server_only_token', tasks: [task] }]);
        expect((await POST(createRequest())).status).toBe(200);
        expect(supabase.pageUpsert).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'server_only_token' }), { onConflict: 'fb_page_id' });
    });

    it('cannot reuse an assignment for a different Page', async () => {
        const supabase = createSupabaseMock({ assigned: true }); mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'member', provider: 'facebook' } });
        mocks.verifiedFacebookPages.mockResolvedValue([]);
        expect((await POST(createRequest({ fbPageId: 'foreign_page' }))).status).toBe(403);
        expect(supabase.pageUpsert).not.toHaveBeenCalled(); expect(supabase.userPagesUpsert).not.toHaveBeenCalled();
    });

    it.each(['PROFILE_PLUS_FACEBOOK_ACCESS', 'ANALYZE', 'MODERATE'])('does not create a Page grant or replace a token from %s alone', async task => {
        const supabase = createSupabaseMock(); mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'member', provider: 'facebook' } });
        mocks.verifiedFacebookPages.mockResolvedValue([{ id: 'fb_page_1', name: 'Page', access_token: 'staff_token', tasks: [task] }]);
        const response = await POST(createRequest());
        expect(response.status).toBe(403);
        expect((await response.json()).message).toContain('Facebook has not granted');
        expect(supabase.pageUpsert).not.toHaveBeenCalled(); expect(supabase.userPagesUpsert).not.toHaveBeenCalled();
        expect(mocks.subscribePageToAppWebhook).not.toHaveBeenCalled();
    });

    it.each(['MESSAGING', 'PROFILE_PLUS_MESSAGING', 'PAGES_MESSAGING'])('opens a shared Page automatically with verified Facebook %s access', async task => {
        const db = createSupabaseMock({ shared: true }); mocks.getSupabaseAdmin.mockReturnValue(db);
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'facebook_staff', provider: 'facebook' } });
        mocks.verifiedFacebookPages.mockResolvedValue([{ id: 'fb_page_1', name: 'Page', access_token: 'staff_token', tasks: [task] }]);
        const response = await POST(createRequest());
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({ pageId: 'page_row_1', needsInitialSync: false, reusedConnection: true });
        expect(JSON.stringify(body)).not.toMatch(/access_token|staff_token/);
        expect(db.pageLookupFilters).toEqual([['fb_page_id', 'fb_page_1']]);
        expect(db.userPagesUpsert).toHaveBeenCalledWith({ user_id: 'facebook_staff', page_id: 'page_row_1', grant_source: 'facebook_messaging' },
            { onConflict: 'user_id,page_id', ignoreDuplicates: true });
        expect(db.pageUpsert).not.toHaveBeenCalled();
        expect(mocks.subscribePageToAppWebhook).not.toHaveBeenCalled();
        expect(mocks.createUtilityTemplate).not.toHaveBeenCalled();
    });

    it.each([false, true])('creates a new messaging connection safely with a concurrent connection=%s', async concurrentInsert => {
        const db = createSupabaseMock({ concurrentInsert }); mocks.getSupabaseAdmin.mockReturnValue(db);
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'facebook_staff', provider: 'facebook' } });
        mocks.verifiedFacebookPages.mockResolvedValue([{ id: 'fb_page_1', name: 'Page', access_token: 'server_only_token', tasks: ['MESSAGING'] }]);
        const response = await POST(createRequest({ accessToken: 'untrusted_client_token' }));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ needsInitialSync: !concurrentInsert, reusedConnection: concurrentInsert });
        expect(db.pageUpsert).toHaveBeenCalledWith({ fb_page_id: 'fb_page_1', name: 'Page', access_token: 'server_only_token' },
            { onConflict: 'fb_page_id', ignoreDuplicates: true });
        expect(mocks.createUtilityTemplate).not.toHaveBeenCalled();
        expect(mocks.subscribePageToAppWebhook).toHaveBeenCalledTimes(concurrentInsert ? 0 : 1);
    });

    it('requires management for explicit shared-token replacement even with messaging access', async () => {
        const db = createSupabaseMock({ assigned: true }); mocks.getSupabaseAdmin.mockReturnValue(db);
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'facebook_staff', provider: 'facebook' } });
        mocks.verifiedFacebookPages.mockResolvedValue([{ id: 'fb_page_1', name: 'Page', access_token: 'staff_token', tasks: ['MESSAGING'] }]);
        expect((await POST(createRequest({ refreshConnection: true }))).status).toBe(403);
        expect(db.pageUpsert).not.toHaveBeenCalled(); expect(db.userPagesUpsert).not.toHaveBeenCalled();
        expect(mocks.subscribePageToAppWebhook).not.toHaveBeenCalled();
    });

    it.each(['pageReadError', 'grantError'])('does not claim a messaging connection succeeds after a %s', async key => {
        const db = createSupabaseMock({ shared: true, [key]: { message: 'Database unavailable' } }); mocks.getSupabaseAdmin.mockReturnValue(db);
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'facebook_staff', provider: 'facebook' } });
        mocks.verifiedFacebookPages.mockResolvedValue([{ id: 'fb_page_1', name: 'Page', access_token: 'staff_token', tasks: ['MESSAGING'] }]);
        expect((await POST(createRequest())).status).toBe(500);
        expect(mocks.subscribePageToAppWebhook).not.toHaveBeenCalled();
    });

    it('fails closed when the membership check fails', async () => {
        const supabase = createSupabaseMock({ accessError: { message: 'Database unavailable' } }); mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'member' } });
        expect((await POST(createRequest())).status).toBe(500);
        expect(mocks.verifiedFacebookPages).not.toHaveBeenCalled();
        expect(supabase.pageUpsert).not.toHaveBeenCalled(); expect(supabase.userPagesUpsert).not.toHaveBeenCalled();
    });

    it('returns a permission-refresh action for an expired Facebook login', async () => {
        const supabase = createSupabaseMock(); mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'manager', provider: 'facebook' } });
        mocks.verifiedFacebookPages.mockRejectedValue(new AccessError(409, 'Refresh permissions'));
        const response = await POST(createRequest());
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ requiresReauth: true, code: 'FACEBOOK_REAUTH_REQUIRED' });
        expect(supabase.pageUpsert).not.toHaveBeenCalled();
    });

    it('distinguishes missing Page consent from a missing Facebook management role', async () => {
        const supabase = createSupabaseMock(); mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'manager', provider: 'facebook' } });
        mocks.verifiedFacebookPages.mockResolvedValue([{ id: 'fb_page_1', name: 'Page', tasks: ['PROFILE_PLUS_FULL_CONTROL'] }]);
        const response = await POST(createRequest());
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ requiresReauth: true, message: expect.stringContaining('recognizes your Page access') });
        expect(supabase.pageUpsert).not.toHaveBeenCalled(); expect(supabase.userPagesUpsert).not.toHaveBeenCalled();
    });

    it('links two managers to the same Page without resetting sync or writing contacts', async () => {
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.subscribePageToAppWebhook.mockResolvedValue(undefined);
        for (const userId of ['manager_1', 'manager_2']) {
            mocks.getSessionFromRequest.mockResolvedValue({ user: { id: userId } });
            const response = await POST(createRequest());
            expect(await response.json()).toMatchObject({ success: true, pageId: 'page_row_1', needsInitialSync: false });
            expect(supabase.userPagesUpsert).toHaveBeenLastCalledWith({ user_id: userId,
                page_id: 'page_row_1', grant_source: 'facebook' }, { onConflict: 'user_id,page_id' });
        }
        for (const [payload, options] of supabase.pageUpsert.mock.calls) {
            expect(options).toEqual({ onConflict: 'fb_page_id' });
            expect(Object.keys(payload).sort()).toEqual(['access_token', 'fb_page_id', 'name', 'updated_at']);
        }
        expect(supabase.from.mock.calls.every(([table]) => ['pages', 'user_pages'].includes(table))).toBe(true);
    });

    it.each([true, false])('requests an initial import only when a never-synced Page has no contacts: existing=%s', async hasContacts => {
        const supabase = createSupabaseMock({ lastSyncedAt: null, hasContacts });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'another_manager' } });
        const response = await POST(createRequest());
        expect(await response.json()).toMatchObject({ success: true, needsInitialSync: !hasContacts });
    });

    it('still saves the fresh page token when webhook subscription fails', async () => {
        const supabase = createSupabaseMock();

        mocks.getSessionFromRequest.mockResolvedValue({
            user: {
                id: 'user_1',
                email: 'user@example.com'
            }
        });
        mocks.subscribePageToAppWebhook.mockRejectedValue(
            new Error('Requires pages_manage_metadata permission')
        );
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.warning.code).toBe('WEBHOOK_SUBSCRIPTION_FAILED');
        expect(body.message).toContain('Requires pages_manage_metadata permission');
        expect(supabase.from).toHaveBeenCalledWith('pages');
        expect(supabase.from).toHaveBeenCalledWith('user_pages');
        expect(supabase.userPagesUpsert.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.subscribePageToAppWebhook.mock.invocationCallOrder[0]
        );
    });
});
