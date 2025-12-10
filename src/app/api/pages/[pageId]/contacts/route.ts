import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { PaginatedResponse, Contact } from '@/types';

// GET /api/pages/[pageId]/contacts - Get contacts with pagination
export async function GET(
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
        const searchParams = request.nextUrl.searchParams;
        const page = parseInt(searchParams.get('page') || '1');
        const pageSize = parseInt(searchParams.get('pageSize') || '25');
        const search = searchParams.get('search') || '';
        const tagId = searchParams.get('tagId') || '';

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

        // Build query
        let query = supabase
            .from('contacts')
            .select('*, contact_tags(tag_id, tags(*))', { count: 'exact' })
            .eq('page_id', pageId)
            .order('last_interaction_at', { ascending: false, nullsFirst: false });

        // Apply search filter
        if (search) {
            query = query.ilike('name', `%${search}%`);
        }

        // Apply tag filter
        if (tagId) {
            // Get contact IDs with this tag
            const { data: taggedContacts } = await supabase
                .from('contact_tags')
                .select('contact_id')
                .eq('tag_id', tagId);

            const contactIds = taggedContacts?.map(tc => tc.contact_id) || [];

            if (contactIds.length > 0) {
                query = query.in('id', contactIds);
            } else {
                // No contacts with this tag
                return NextResponse.json({
                    items: [],
                    page,
                    pageSize,
                    total: 0
                } as PaginatedResponse<Contact>);
            }
        }

        // Apply pagination
        const from = (page - 1) * pageSize;
        const to = from + pageSize - 1;
        query = query.range(from, to);

        const { data: contacts, error, count } = await query;

        if (error) throw error;

        // Transform contacts to include tags array
        const transformedContacts = contacts?.map(contact => ({
            ...contact,
            tags: contact.contact_tags?.map((ct: { tags: unknown }) => ct.tags) || [],
            contact_tags: undefined
        })) || [];

        return NextResponse.json({
            items: transformedContacts,
            page,
            pageSize,
            total: count || 0
        } as PaginatedResponse<Contact>);
    } catch (error) {
        console.error('Error fetching contacts:', error);
        return NextResponse.json(
            { error: 'Failed to fetch contacts', message: (error as Error).message },
            { status: 500 }
        );
    }
}
