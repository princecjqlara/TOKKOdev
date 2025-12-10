import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';

// POST /api/pages/[pageId]/contacts/bulk-add-tags - Add tags to contacts
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

        // Verify contacts belong to this page
        const { data: validContacts } = await supabase
            .from('contacts')
            .select('id')
            .in('id', contactIds)
            .eq('page_id', pageId);

        const validContactIds = validContacts?.map(c => c.id) || [];

        // Create contact_tags entries
        const entries = [];
        for (const contactId of validContactIds) {
            for (const tagId of tagIds) {
                entries.push({
                    contact_id: contactId,
                    tag_id: tagId
                });
            }
        }

        if (entries.length > 0) {
            // Use upsert to avoid duplicates
            const { error } = await supabase
                .from('contact_tags')
                .upsert(entries, {
                    onConflict: 'contact_id,tag_id',
                    ignoreDuplicates: true
                });

            if (error) throw error;
        }

        return NextResponse.json({
            success: true,
            addedCount: entries.length
        });
    } catch (error) {
        console.error('Error adding tags to contacts:', error);
        return NextResponse.json(
            { error: 'Failed to add tags', message: (error as Error).message },
            { status: 500 }
        );
    }
}
