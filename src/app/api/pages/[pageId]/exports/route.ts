import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_SELECTED_CONTACTS = 100_000;

function sanitizeFilenamePart(value: string) {
    return value
        .trim()
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'page';
}

function normalizeContactIds(value: unknown) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value
        .map((item) => typeof item === 'string' ? item.trim() : '')
        .filter(Boolean))];
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const session = await getSessionFromRequest(request);
        const userId = session?.user?.id;
        if (!userId) {
            return NextResponse.json({ message: 'Please sign in.' }, { status: 401 });
        }

        const { pageId } = await params;
        const body = await request.json().catch(() => ({}));
        const contactIds = normalizeContactIds(body.contactIds);
        const scope = body.scope === 'selected' || contactIds.length > 0 ? 'selected' : 'all';
        if (scope === 'selected' && contactIds.length === 0) {
            return NextResponse.json({ message: 'Select at least one contact to export.' }, { status: 400 });
        }
        if (contactIds.length > MAX_SELECTED_CONTACTS) {
            return NextResponse.json(
                { message: `A single export can include at most ${MAX_SELECTED_CONTACTS.toLocaleString()} selected contacts.` },
                { status: 413 }
            );
        }

        const supabase = getSupabaseAdmin();
        const { data: membership } = await supabase
            .from('user_pages')
            .select('pages(id, name)')
            .eq('user_id', userId)
            .eq('page_id', pageId)
            .single();
        const rawPage = Array.isArray(membership?.pages) ? membership.pages[0] : membership?.pages;
        const page = rawPage as { id: string; name: string } | null;
        if (!page) {
            return NextResponse.json({ message: 'You do not have access to this Facebook Page.' }, { status: 403 });
        }

        let totalItems = contactIds.length;
        if (scope === 'all') {
            const { count, error: countError } = await supabase
                .from('contacts')
                .select('id', { count: 'exact', head: true })
                .eq('page_id', pageId);
            if (countError) throw countError;
            totalItems = count || 0;
        }

        const jobId = randomUUID();
        const date = new Date().toISOString().slice(0, 10);
        const filename = `${sanitizeFilenamePart(page.name)}-${scope === 'selected' ? 'selected-contact-conversations' : 'conversations'}-${date}.csv`;
        const { data: job, error: insertError } = await supabase
            .from('conversation_export_jobs')
            .insert({
                id: jobId,
                page_id: pageId,
                created_by: userId,
                scope,
                status: 'queued',
                contact_ids: contactIds,
                total_items: totalItems,
                filename,
                storage_prefix: `${userId}/${jobId}`
            })
            .select('id, status, filename, created_at')
            .single();
        if (insertError) throw insertError;

        return NextResponse.json({
            success: true,
            job,
            message: 'Export queued. It will keep running even if you close this browser.'
        }, { status: 202 });
    } catch (error) {
        console.error('[EXPORT_CREATE] Failed:', error);
        const message = (error as { message?: string })?.message || 'Could not create the export.';
        const migrationMissing = /conversation_export_jobs|claim_conversation_export_job/i.test(message);
        return NextResponse.json({
            message: migrationMissing
                ? 'The export queue database migration has not been installed yet.'
                : message
        }, { status: 500 });
    }
}
