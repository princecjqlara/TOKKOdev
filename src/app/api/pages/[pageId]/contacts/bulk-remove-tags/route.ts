import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';

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

        // Delete contact_tags entries
        const { error, count } = await supabase
            .from('contact_tags')
            .delete()
            .in('contact_id', contactIds)
            .in('tag_id', tagIds);

        if (error) throw error;

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
