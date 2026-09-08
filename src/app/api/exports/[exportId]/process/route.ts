import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { processConversationExportQueue } from '@/lib/conversation-export-jobs';

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
    const { data: ownedJob, error: lookupError } = await supabase
        .from('conversation_export_jobs')
        .select('id, status')
        .eq('id', exportId)
        .eq('created_by', userId)
        .maybeSingle();

    if (lookupError) return NextResponse.json({ message: lookupError.message }, { status: 500 });
    if (!ownedJob) return NextResponse.json({ message: 'Export not found.' }, { status: 404 });
    if (ownedJob.status !== 'queued' && ownedJob.status !== 'running') {
        return NextResponse.json({ message: 'This export is not active.' }, { status: 409 });
    }

    const results = await processConversationExportQueue({
        jobId: exportId,
        maxBatches: 1,
        maxDurationMs: 240_000
    });

    return NextResponse.json({ success: true, result: results[0] || null });
}
