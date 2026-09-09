import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { CONVERSATION_EXPORT_BUCKET } from '@/lib/conversation-export-jobs';
import { userHasPageAccess } from '@/lib/page-access';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function safeDownloadFilename(value: string) {
    return value.replace(/[\r\n"\\]/g, '-').slice(0, 180) || 'facebook-conversations.csv';
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ exportId: string }> }
) {
    const session = await getSessionFromRequest(request);
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ message: 'Please sign in.' }, { status: 401 });
    const { exportId } = await params;
    const supabase = getSupabaseAdmin();
    const { data: job, error } = await supabase
        .from('conversation_export_jobs')
        .select('page_id, status, filename, storage_prefix, chunk_count, expires_at')
        .eq('id', exportId)
        .maybeSingle();

    if (error) return NextResponse.json({ message: error.message }, { status: 500 });
    if (!job || !await userHasPageAccess(userId, job.page_id)) {
        return NextResponse.json({ message: 'Export not found.' }, { status: 404 });
    }
    if (job.status !== 'completed') {
        return NextResponse.json({ message: 'This export is not ready to download yet.' }, { status: 409 });
    }
    if (new Date(job.expires_at).getTime() <= Date.now()) {
        return NextResponse.json({ message: 'This export has expired.' }, { status: 410 });
    }

    const chunkCount = Number(job.chunk_count || 0);
    if (chunkCount === 0) return NextResponse.json({ message: 'The export file is empty.' }, { status: 500 });

    let nextChunk = 0;
    const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (nextChunk >= chunkCount) {
                controller.close();
                return;
            }
            try {
                const chunkIndex = nextChunk++;
                const path = `${job.storage_prefix}/chunk-${String(chunkIndex).padStart(6, '0')}.csv`;
                const { data, error: downloadError } = await supabase.storage
                    .from(CONVERSATION_EXPORT_BUCKET)
                    .download(path);
                if (downloadError || !data) throw downloadError || new Error(`Missing export chunk ${chunkIndex + 1}.`);
                controller.enqueue(new Uint8Array(await data.arrayBuffer()));
            } catch (streamError) {
                controller.error(streamError);
            }
        }
    });

    return new NextResponse(stream, {
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${safeDownloadFilename(job.filename)}"`,
            'Cache-Control': 'private, no-store'
        }
    });
}
