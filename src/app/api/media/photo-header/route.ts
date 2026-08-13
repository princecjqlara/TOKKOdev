import { randomUUID } from 'crypto';
import { getServerSession } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';

const PHOTO_HEADER_BUCKET = 'photo-headers';
const MAX_PHOTO_HEADER_BYTES = 3 * 1024 * 1024;
const SIGNED_URL_LIFETIME_SECONDS = 60 * 60 * 24 * 365;
const SUPPORTED_IMAGE_TYPES: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif'
};

async function ensurePhotoHeaderBucket() {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase.storage.getBucket(PHOTO_HEADER_BUCKET);
    if (data) return;

    const { error } = await supabase.storage.createBucket(PHOTO_HEADER_BUCKET, {
        public: false,
        fileSizeLimit: MAX_PHOTO_HEADER_BYTES,
        allowedMimeTypes: Object.keys(SUPPORTED_IMAGE_TYPES)
    });

    // Another concurrent request may have created the bucket first.
    if (error) {
        const retry = await supabase.storage.getBucket(PHOTO_HEADER_BUCKET);
        if (!retry.data) throw error;
    }
}

export async function POST(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) {
            return NextResponse.json({ message: 'Please sign in.' }, { status: 401 });
        }

        const formData = await request.formData();
        const pageId = formData.get('pageId');
        const file = formData.get('file');

        if (typeof pageId !== 'string' || !pageId.trim()) {
            return NextResponse.json({ message: 'A Facebook page is required.' }, { status: 400 });
        }
        if (!file || typeof file === 'string') {
            return NextResponse.json({ message: 'Choose a photo to upload.' }, { status: 400 });
        }

        const extension = SUPPORTED_IMAGE_TYPES[file.type];
        if (!extension) {
            return NextResponse.json(
                { message: 'Use a JPG, PNG, WebP, or GIF photo.' },
                { status: 415 }
            );
        }
        if (file.size <= 0 || file.size > MAX_PHOTO_HEADER_BYTES) {
            return NextResponse.json({ message: 'The photo must be under 3 MB.' }, { status: 413 });
        }

        const supabase = getSupabaseAdmin();
        const { data: userPage } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', session.user.id)
            .eq('page_id', pageId.trim())
            .single();

        if (!userPage) {
            return NextResponse.json({ message: 'You do not have access to this page.' }, { status: 403 });
        }

        await ensurePhotoHeaderBucket();

        const storagePath = `${session.user.id}/${pageId.trim()}/${randomUUID()}.${extension}`;
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { error: uploadError } = await supabase.storage
            .from(PHOTO_HEADER_BUCKET)
            .upload(storagePath, bytes, {
                contentType: file.type,
                cacheControl: '3600',
                upsert: false
            });
        if (uploadError) throw uploadError;

        const { data: signedData, error: signedUrlError } = await supabase.storage
            .from(PHOTO_HEADER_BUCKET)
            .createSignedUrl(storagePath, SIGNED_URL_LIFETIME_SECONDS);
        if (signedUrlError || !signedData?.signedUrl) {
            await supabase.storage.from(PHOTO_HEADER_BUCKET).remove([storagePath]);
            throw signedUrlError || new Error('Storage did not return a photo URL.');
        }

        return NextResponse.json({
            success: true,
            url: signedData.signedUrl
        });
    } catch (error) {
        console.error('Photo header upload failed:', error);
        return NextResponse.json(
            { message: error instanceof Error ? error.message : 'Could not upload the photo header.' },
            { status: 500 }
        );
    }
}
