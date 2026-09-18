import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    createSignedUploadUrl: vi.fn()
}));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: mocks.getSessionFromRequest }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));

import { POST } from './route';

function request(mimeType: string, size: number) {
    return new NextRequest('http://localhost/api/pages/page-1/human-agent-media', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mimeType, size })
    });
}

describe('Human Agent media upload preparation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'user-1' } });
        mocks.createSignedUploadUrl.mockResolvedValue({ data: { token: 'signed-token' }, error: null });
        mocks.getSupabaseAdmin.mockReturnValue({
            from: () => ({
                select() { return this; },
                eq() { return this; },
                maybeSingle: vi.fn().mockResolvedValue({ data: { page_id: 'page-1' }, error: null })
            }),
            storage: {
                getBucket: vi.fn().mockResolvedValue({ data: { id: 'messenger-agent-media' } }),
                from: () => ({ createSignedUploadUrl: mocks.createSignedUploadUrl })
            }
        });
    });

    it('rejects executable and oversized uploads', async () => {
        const executable = await POST(request('application/x-msdownload', 100), { params: Promise.resolve({ pageId: 'page-1' }) });
        const oversized = await POST(request('image/png', 11 * 1024 * 1024), { params: Promise.resolve({ pageId: 'page-1' }) });
        expect(executable.status).toBe(400);
        expect(oversized.status).toBe(400);
        expect(mocks.createSignedUploadUrl).not.toHaveBeenCalled();
    });

    it('prepares a private signed upload for a supported file', async () => {
        const response = await POST(request('image/png', 100), { params: Promise.resolve({ pageId: 'page-1' }) });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.type).toBe('image');
        expect(body.path).toMatch(/^user-1\/page-1\/[0-9a-f-]{36}\.png$/);
        expect(body.token).toBe('signed-token');
    });
});
