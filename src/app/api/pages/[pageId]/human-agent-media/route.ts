import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import {
    MAX_MESSENGER_MEDIA_BYTES,
    MESSENGER_MEDIA_BUCKET,
    MESSENGER_MEDIA_MIME_TYPES
} from '@/lib/messenger-media';

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) {
            return NextResponse.json({ message: 'Please sign in.' }, { status: 401 });
        }
        const { pageId } = await params;
        const body = await request.json().catch(() => ({}));
        const mimeType = typeof body.mimeType === 'string' ? body.mimeType.toLowerCase() : '';
        const size = body.size;
        const media = MESSENGER_MEDIA_MIME_TYPES[mimeType];
        if (!media || !Number.isInteger(size) || size <= 0 || size > MAX_MESSENGER_MEDIA_BYTES) {
            return NextResponse.json({ message: 'Choose a supported image, video, audio, or document up to 10 MB.' }, { status: 400 });
        }

        const db = getSupabaseAdmin();
        const { data: access, error: accessError } = await db.from('user_pages')
            .select('page_id').eq('user_id', session.user.id).eq('page_id', pageId).maybeSingle();
        if (accessError) throw accessError;
        if (!access) return NextResponse.json({ message: 'You do not have access to this page.' }, { status: 403 });

        const { data: bucket } = await db.storage.getBucket(MESSENGER_MEDIA_BUCKET);
        if (!bucket) {
            const { error: bucketError } = await db.storage.createBucket(MESSENGER_MEDIA_BUCKET, {
                public: false,
                fileSizeLimit: MAX_MESSENGER_MEDIA_BYTES,
                allowedMimeTypes: Object.keys(MESSENGER_MEDIA_MIME_TYPES)
            });
            if (bucketError) {
                const retry = await db.storage.getBucket(MESSENGER_MEDIA_BUCKET);
                if (!retry.data) throw bucketError;
            }
        }

        const path = `${session.user.id}/${pageId}/${randomUUID()}.${media.extension}`;
        const { data, error } = await db.storage.from(MESSENGER_MEDIA_BUCKET).createSignedUploadUrl(path);
        if (error || !data?.token) throw error || new Error('Could not prepare the media upload.');
        return NextResponse.json({ path, token: data.token, type: media.type, bucket: MESSENGER_MEDIA_BUCKET });
    } catch (error) {
        console.error('Human Agent media upload setup failed:', error);
        return NextResponse.json({ message: 'Could not prepare the media upload.' }, { status: 500 });
    }
}
