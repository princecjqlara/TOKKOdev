import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { processConversationExportQueue } from '@/lib/conversation-export-jobs';
import { userHasPageAccess } from '@/lib/page-access';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ exportId: string }> }
) {
    const session = await getSessionFromRequest(request);
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ message: 'Please sign in.' }, { status: 401 });

    const { exportId } = await params;
    const supabase = getSupabaseAdmin();
    const { data: accessibleJob, error: lookupError } = await supabase
        .from('conversation_export_jobs')
        .select('id, page_id, status')
        .eq('id', exportId)
        .maybeSingle();

    if (lookupError) return NextResponse.json({ message: lookupError.message }, { status: 500 });
    if (!accessibleJob || !await userHasPageAccess(userId, accessibleJob.page_id)) {
        return NextResponse.json({ message: 'Export not found.' }, { status: 404 });
    }
    if (accessibleJob.status !== 'queued' && accessibleJob.status !== 'running') {
        return NextResponse.json({ message: 'This export is not active.' }, { status: 409 });
    }

    const results = await processConversationExportQueue({
        jobId: exportId,
        // Run up to ten durable checkpoints per browser request. This keeps
        // the same lossless 25-conversation checkpoints while removing nine
        // extra request/poll cycles from the common path.
        maxBatches: 10,
        maxDurationMs: 50_000
    });

    return NextResponse.json({
        success: true,
        batchesProcessed: results.length,
        result: results.at(-1) || null
    });
}
