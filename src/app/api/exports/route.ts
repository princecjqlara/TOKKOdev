import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getUserPageIds } from '@/lib/page-access';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);
        const userId = session?.user?.id;
        if (!userId) return NextResponse.json({ message: 'Please sign in.' }, { status: 401 });

        const pageIds = await getUserPageIds(userId);
        if (pageIds.length === 0) return NextResponse.json({ jobs: [] });

        const { data, error } = await getSupabaseAdmin()
            .from('conversation_export_jobs')
            .select(`
                id, page_id, scope, status, total_items, processed_items,
                conversation_count, message_count, filename, error_message,
                attempt_count, started_at, completed_at, expires_at, created_at,
                pages(name)
            `)
            .in('page_id', pageIds)
            .order('created_at', { ascending: false })
            .limit(100);
        if (error) throw error;

        const jobs = (data || []).map((job: Record<string, any>) => {
            const page = Array.isArray(job.pages) ? job.pages[0] : job.pages;
            const { pages: _pages, ...safeJob } = job;
            return { ...safeJob, page_name: page?.name || 'Facebook Page' };
        });
        return NextResponse.json({ jobs });
    } catch (error) {
        const message = (error as { message?: string })?.message || 'Could not load exports.';
        return NextResponse.json({
            message: /conversation_export_jobs/i.test(message)
                ? 'The export queue database migration has not been installed yet.'
                : message
        }, { status: 500 });
    }
}
