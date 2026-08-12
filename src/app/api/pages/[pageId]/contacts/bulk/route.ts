import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { recordPageActivity } from '@/lib/activity-history';
import { SUPABASE_IN_FILTER_BATCH_SIZE } from '@/lib/supabase-pagination';

const CHUNK_SIZE = SUPABASE_IN_FILTER_BATCH_SIZE;

// DELETE /api/pages/[pageId]/contacts/bulk - Bulk delete contacts
export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const { pageId } = await params;
        const body = await request.json();
        const { contactIds } = body as { contactIds?: string[] };

        if (!contactIds?.length) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'No contact IDs provided' },
                { status: 400 }
            );
        }

        const supabase = getSupabaseAdmin();

        // Verify user has access to page
        const { data: userPage } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', session.user.id)
            .eq('page_id', pageId)
            .single();

        if (!userPage) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this page' },
                { status: 403 }
            );
        }

        const chunks: string[][] = [];
        for (let i = 0; i < contactIds.length; i += CHUNK_SIZE) {
            chunks.push(contactIds.slice(i, i + CHUNK_SIZE));
        }

        const deletedContacts: Array<{ id: string; name: string | null; psid: string }> = [];
        let deletedCount = 0;

        // Delete related rows in manageable chunks, scoping to verified page
        for (const chunk of chunks) {
            // First verify these contacts belong to this page
            const { data: validContacts } = await supabase
                .from('contacts')
                .select('id, name, psid')
                .in('id', chunk)
                .eq('page_id', pageId);

            const validIds = (validContacts || []).map(c => c.id);
            if (!validIds.length) continue;
            deletedCount += validIds.length;
            if (deletedContacts.length < 100) {
                deletedContacts.push(...(validContacts || []).slice(0, 100 - deletedContacts.length));
            }

            await supabase.from('contact_tags').delete().in('contact_id', validIds);
            await supabase.from('campaign_recipients').delete().in('contact_id', validIds);
            const { error } = await supabase
                .from('contacts')
                .delete()
                .in('id', validIds)
                .eq('page_id', pageId);
            if (error) throw error;
        }

        await recordPageActivity(supabase, {
            pageId,
            actorUserId: session.user.id,
            actionType: 'bulk_contacts_deleted',
            entityType: 'contacts',
            summary: `Deleted ${deletedCount} contact${deletedCount === 1 ? '' : 's'}`,
            targetCount: contactIds.length,
            successCount: deletedCount,
            failureCount: Math.max(0, contactIds.length - deletedCount),
            status: deletedCount === contactIds.length ? 'completed' : 'partial',
            details: {
                requestedContactCount: contactIds.length,
                deletedContacts,
                contactListTruncated: deletedCount > deletedContacts.length
            }
        });

        return NextResponse.json({
            success: true,
            deletedCount
        });
    } catch (error) {
        console.error('Error deleting contacts:', error);
        return NextResponse.json(
            { error: 'Failed to delete contacts', message: (error as Error).message },
            { status: 500 }
        );
    }
}
