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
    const { data, error } = await supabase
        .from('conversation_export_jobs')
        .update({
            status: 'queued',
            error_message: null,
            attempt_count: 0,
            next_attempt_at: null,
            completed_at: null,
            claim_token: null,
            claimed_at: null
        })
        .eq('id', exportId)
        .eq('created_by', userId)
        .eq('status', 'failed')
        .select('id')
        .maybeSingle();
    if (error) return NextResponse.json({ message: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ message: 'This export cannot be retried.' }, { status: 409 });

    await processConversationExportQueue({ jobId: exportId, maxBatches: 1, maxDurationMs: 240_000 });
    return NextResponse.json({ success: true });
}

