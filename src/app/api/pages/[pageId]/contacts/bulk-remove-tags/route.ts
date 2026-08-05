import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { recordPageActivity } from '@/lib/activity-history';

// POST /api/pages/[pageId]/contacts/bulk-remove-tags - Remove tags from contacts
export async function POST(
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
        const { contactIds, tagIds } = body;

        if (!contactIds?.length || !tagIds?.length) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Contact IDs and Tag IDs are required' },
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

        // Verify contacts belong to this page before removing tags
        const { data: validContacts } = await supabase
            .from('contacts')
            .select('id')
            .in('id', contactIds)
            .eq('page_id', pageId);

        const validContactIds = (validContacts || []).map(c => c.id);
        if (!validContactIds.length) {
            return NextResponse.json({ success: true, removedCount: 0 });
        }

        // Delete contact_tags entries only for verified contacts
        const { error, count } = await supabase
            .from('contact_tags')
            .delete({ count: 'exact' })
            .in('contact_id', validContactIds)
            .in('tag_id', tagIds);

        if (error) throw error;

        await recordPageActivity(supabase, {
            pageId,
            actorUserId: session.user.id,
            actionType: 'bulk_tags_removed',
            entityType: 'contacts',
            summary: `Removed tags from ${validContactIds.length} contact${validContactIds.length === 1 ? '' : 's'}`,
            targetCount: validContactIds.length,
            successCount: validContactIds.length,
            details: {
                requestedContactCount: contactIds.length,
                matchedContactCount: validContactIds.length,
                tagCount: tagIds.length,
                removedAssignmentCount: count || 0,
                tagIds: tagIds.slice(0, 100),
                contactIds: validContactIds.slice(0, 100),
                tagListTruncated: tagIds.length > 100,
                contactListTruncated: validContactIds.length > 100
            }
        });

        return NextResponse.json({
            success: true,
            removedCount: count || 0
        });
    } catch (error) {
        console.error('Error removing tags from contacts:', error);
        return NextResponse.json(
            { error: 'Failed to remove tags', message: (error as Error).message },
            { status: 500 }
        );
    }
}
