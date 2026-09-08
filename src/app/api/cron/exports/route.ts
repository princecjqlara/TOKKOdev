import { NextResponse } from 'next/server';
import { chunkArray } from '@/lib/chunking';
import { getSupabaseAdmin } from '@/lib/supabase';
import {
    CONVERSATION_EXPORT_BUCKET,
    processConversationExportQueue
} from '@/lib/conversation-export-jobs';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function removeExpiredExports() {
    const supabase = getSupabaseAdmin();
    const { data: expired, error } = await supabase
        .from('conversation_export_jobs')
        .select('id, storage_prefix, chunk_count')
        .lt('expires_at', new Date().toISOString())
        .limit(25);
    if (error) throw error;

    for (const job of expired || []) {
        const paths = Array.from({ length: Number(job.chunk_count || 0) }, (_, index) =>
            `${job.storage_prefix}/chunk-${String(index).padStart(6, '0')}.csv`
        );
        for (const batch of chunkArray(paths, 100)) {
            if (batch.length > 0) await supabase.storage.from(CONVERSATION_EXPORT_BUCKET).remove(batch);
        }
        await supabase.from('conversation_export_jobs').delete().eq('id', job.id);
    }
    return expired?.length || 0;
}

export async function GET() {
    try {
        const results = await processConversationExportQueue({ maxBatches: 10, maxDurationMs: 50_000 });
        const removedExpired = await removeExpiredExports();
        return NextResponse.json({ success: true, processed: results.length, removedExpired, results });
    } catch (error) {
        return NextResponse.json({
            error: 'Export worker failed',
            message: error instanceof Error ? error.message : String(error)
        }, { status: 500 });
    }
}
