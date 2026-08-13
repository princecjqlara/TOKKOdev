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

function createRequest(file = new File(['photo'], 'header.png', { type: 'image/png' })): NextRequest {
    const formData = new FormData();
    formData.set('pageId', 'page_1');
    formData.set('file', file);

    return new Request('http://localhost:3000/api/media/photo-header', {
        method: 'POST',
        body: formData
    }) as unknown as NextRequest;
}

function createSupabaseMock(options: { hasPageAccess?: boolean; bucketExists?: boolean } = {}) {
    const hasPageAccess = options.hasPageAccess ?? true;
    const bucketExists = options.bucketExists ?? true;
    const upload = vi.fn().mockResolvedValue({ error: null });
    const createSignedUrl = vi.fn().mockResolvedValue({
        data: { signedUrl: 'https://storage.example.com/photo.png?token=signed' },
        error: null
    });
    const remove = vi.fn().mockResolvedValue({ error: null });
    const getBucket = vi.fn().mockResolvedValue({
        data: bucketExists ? { id: 'photo-headers' } : null,
        error: bucketExists ? null : { message: 'Bucket not found' }
    });
    const createBucket = vi.fn().mockResolvedValue({ error: null });

    const supabase = {
        from: vi.fn((table: string) => {
            if (table !== 'user_pages') throw new Error(`Unexpected table: ${table}`);
            return {
                select: vi.fn(() => ({
                    eq: vi.fn(() => ({
                        eq: vi.fn(() => ({
                            single: vi.fn().mockResolvedValue({
                                data: hasPageAccess ? { page_id: 'page_1' } : null,
                                error: hasPageAccess ? null : { message: 'Not found' }
                            })
                        }))
                    }))
                }))
            };
        }),
        storage: {
            getBucket,
            createBucket,
            from: vi.fn((bucket: string) => {
                if (bucket !== 'photo-headers') throw new Error(`Unexpected bucket: ${bucket}`);
                return { upload, createSignedUrl, remove };
            })
        }
    };

    return { supabase, upload, createSignedUrl, getBucket, createBucket };
}

describe('POST /api/media/photo-header', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });
    });

    it('requires an authenticated user', async () => {
        mocks.getServerSession.mockResolvedValue(null);

        const response = await POST(createRequest());

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ message: 'Please sign in.' });
        expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    });

    it('rejects uploads for pages the user cannot access', async () => {
        const { supabase, upload } = createSupabaseMock({ hasPageAccess: false });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest());

        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ message: 'You do not have access to this page.' });
        expect(upload).not.toHaveBeenCalled();
    });

    it('rejects unsupported image formats before accessing storage', async () => {
        const { supabase, getBucket } = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest(new File(['photo'], 'header.svg', { type: 'image/svg+xml' })));

        expect(response.status).toBe(415);
        expect(await response.json()).toEqual({ message: 'Use a JPG, PNG, WebP, or GIF photo.' });
        expect(getBucket).not.toHaveBeenCalled();
    });

    it('creates the private bucket when needed and returns a signed photo URL', async () => {
        const { supabase, upload, createSignedUrl, createBucket } = createSupabaseMock({ bucketExists: false });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await POST(createRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({
            success: true,
            url: 'https://storage.example.com/photo.png?token=signed'
        });
        expect(createBucket).toHaveBeenCalledWith('photo-headers', {
            public: false,
            fileSizeLimit: 3 * 1024 * 1024,
            allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
        });
        expect(upload).toHaveBeenCalledWith(
            expect.stringMatching(/^user_1\/page_1\/[0-9a-f-]+\.png$/),
            expect.any(Uint8Array),
            { contentType: 'image/png', cacheControl: '3600', upsert: false }
        );
        expect(createSignedUrl).toHaveBeenCalledWith(expect.stringMatching(/\.png$/), 60 * 60 * 24 * 365);
    });
});
