import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';

// DELETE /api/tags/bulk - Bulk delete tags
export async function DELETE(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const body = await request.json();
        const { tagIds } = body;

        if (!tagIds?.length) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'No tag IDs provided' },
                { status: 400 }
            );
        }

        const supabase = getSupabaseAdmin();

        // Get all tags and verify permission for each
        const { data: tags } = await supabase
            .from('tags')
            .select('*')
            .in('id', tagIds);

        if (!tags?.length) {
            return NextResponse.json(
                { error: 'Not Found', message: 'No valid tags found' },
                { status: 404 }
            );
        }

        // Get user's accessible pages and businesses
        const { data: userPages } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', session.user.id);

        const { data: businessUsers } = await supabase
            .from('business_users')
            .select('business_id')
            .eq('user_id', session.user.id);

        const accessiblePageIds = userPages?.map(up => up.page_id) || [];
        const accessibleBusinessIds = businessUsers?.map(bu => bu.business_id) || [];

        // Filter to only tags user has permission to delete
        const allowedTagIds = tags
            .filter(tag => {
                if (tag.owner_type === 'user' && tag.owner_id === session.user.id) return true;
                if (tag.owner_type === 'page' && accessiblePageIds.includes(tag.owner_id)) return true;
                if (tag.owner_type === 'business' && accessibleBusinessIds.includes(tag.owner_id)) return true;
                return false;
            })
            .map(tag => tag.id);

        if (allowedTagIds.length === 0) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'No permission to delete any of the specified tags' },
                { status: 403 }
            );
        }

        // Delete contact_tags first
        await supabase
            .from('contact_tags')
            .delete()
            .in('tag_id', allowedTagIds);

        // Delete tags
        const { error } = await supabase
            .from('tags')
            .delete()
            .in('id', allowedTagIds);

        if (error) throw error;

        return NextResponse.json({
            success: true,
            deletedCount: allowedTagIds.length,
            skippedCount: tagIds.length - allowedTagIds.length
        });
    } catch (error) {
        console.error('Error bulk deleting tags:', error);
        return NextResponse.json(
            { error: 'Failed to delete tags', message: (error as Error).message },
            { status: 500 }
        );
    }
}
