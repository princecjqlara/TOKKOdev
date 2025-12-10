import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { PaginatedResponse, Tag } from '@/types';

// GET /api/tags - Get tags with pagination
export async function GET(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const searchParams = request.nextUrl.searchParams;
        const page = parseInt(searchParams.get('page') || '1');
        const pageSize = parseInt(searchParams.get('pageSize') || '50');
        const scope = searchParams.get('scope') || 'all'; // user, page, business, all
        const pageId = searchParams.get('pageId') || '';

        const supabase = getSupabaseAdmin();

        // Build query based on scope
        let query = supabase
            .from('tags')
            .select('*', { count: 'exact' })
            .order('name');

        if (scope === 'user') {
            query = query.eq('owner_type', 'user').eq('owner_id', session.user.id);
        } else if (scope === 'page' && pageId) {
            query = query.eq('owner_type', 'page').eq('owner_id', pageId);
        } else if (scope === 'business') {
            // Get user's business IDs
            const { data: businessUsers } = await supabase
                .from('business_users')
                .select('business_id')
                .eq('user_id', session.user.id);

            const businessIds = businessUsers?.map(bu => bu.business_id) || [];
            if (businessIds.length > 0) {
                query = query.eq('owner_type', 'business').in('owner_id', businessIds);
            } else {
                return NextResponse.json({
                    items: [],
                    page,
                    pageSize,
                    total: 0
                } as PaginatedResponse<Tag>);
            }
        } else {
            // Get all accessible tags (user's own + pages they have access to + their businesses)
            const { data: userPages } = await supabase
                .from('user_pages')
                .select('page_id')
                .eq('user_id', session.user.id);

            const { data: businessUsers } = await supabase
                .from('business_users')
                .select('business_id')
                .eq('user_id', session.user.id);

            const pageIds = userPages?.map(up => up.page_id) || [];
            const businessIds = businessUsers?.map(bu => bu.business_id) || [];

            // Complex OR condition - get user tags, page tags, and business tags
            query = query.or(
                `owner_type.eq.user.and.owner_id.eq.${session.user.id},` +
                (pageIds.length > 0 ? `owner_type.eq.page.and.owner_id.in.(${pageIds.join(',')}),` : '') +
                (businessIds.length > 0 ? `owner_type.eq.business.and.owner_id.in.(${businessIds.join(',')})` : '')
            );
        }

        // Apply pagination
        const from = (page - 1) * pageSize;
        const to = from + pageSize - 1;
        query = query.range(from, to);

        const { data: tags, error, count } = await query;

        if (error) throw error;

        return NextResponse.json({
            items: tags || [],
            page,
            pageSize,
            total: count || 0
        } as PaginatedResponse<Tag>);
    } catch (error) {
        console.error('Error fetching tags:', error);
        return NextResponse.json(
            { error: 'Failed to fetch tags', message: (error as Error).message },
            { status: 500 }
        );
    }
}

// POST /api/tags - Create a new tag
export async function POST(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const body = await request.json();
        const { name, color, ownerType, ownerId, pageId } = body;

        if (!name || !ownerType || !ownerId) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Name, ownerType, and ownerId are required' },
                { status: 400 }
            );
        }

        const supabase = getSupabaseAdmin();

        // Verify ownership permission
        if (ownerType === 'page') {
            const { data: userPage } = await supabase
                .from('user_pages')
                .select('page_id')
                .eq('user_id', session.user.id)
                .eq('page_id', ownerId)
                .single();

            if (!userPage) {
                return NextResponse.json(
                    { error: 'Forbidden', message: 'You do not have access to this page' },
                    { status: 403 }
                );
            }
        } else if (ownerType === 'business') {
            const { data: businessUser } = await supabase
                .from('business_users')
                .select('business_id')
                .eq('user_id', session.user.id)
                .eq('business_id', ownerId)
                .single();

            if (!businessUser) {
                return NextResponse.json(
                    { error: 'Forbidden', message: 'You do not have access to this business' },
                    { status: 403 }
                );
            }
        } else if (ownerType === 'user' && ownerId !== session.user.id) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'Cannot create tags for other users' },
                { status: 403 }
            );
        }

        const { data: tag, error } = await supabase
            .from('tags')
            .insert({
                name,
                color: color || '#6366f1',
                owner_type: ownerType,
                owner_id: ownerId,
                page_id: pageId || null
            })
            .select()
            .single();

        if (error) throw error;

        return NextResponse.json({ tag });
    } catch (error) {
        console.error('Error creating tag:', error);
        return NextResponse.json(
            { error: 'Failed to create tag', message: (error as Error).message },
            { status: 500 }
        );
    }
}

// PUT /api/tags - Update a tag
export async function PUT(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const body = await request.json();
        const { id, name, color } = body;

        if (!id) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Tag ID is required' },
                { status: 400 }
            );
        }

        const supabase = getSupabaseAdmin();

        // Get tag and verify permission
        const { data: existingTag } = await supabase
            .from('tags')
            .select('*')
            .eq('id', id)
            .single();

        if (!existingTag) {
            return NextResponse.json(
                { error: 'Not Found', message: 'Tag not found' },
                { status: 404 }
            );
        }

        // Verify permission based on owner_type
        let hasPermission = false;
        if (existingTag.owner_type === 'user' && existingTag.owner_id === session.user.id) {
            hasPermission = true;
        } else if (existingTag.owner_type === 'page') {
            const { data: userPage } = await supabase
                .from('user_pages')
                .select('page_id')
                .eq('user_id', session.user.id)
                .eq('page_id', existingTag.owner_id)
                .single();
            hasPermission = !!userPage;
        } else if (existingTag.owner_type === 'business') {
            const { data: businessUser } = await supabase
                .from('business_users')
                .select('business_id')
                .eq('user_id', session.user.id)
                .eq('business_id', existingTag.owner_id)
                .single();
            hasPermission = !!businessUser;
        }

        if (!hasPermission) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have permission to edit this tag' },
                { status: 403 }
            );
        }

        const updates: { name?: string; color?: string } = {};
        if (name) updates.name = name;
        if (color) updates.color = color;

        const { data: tag, error } = await supabase
            .from('tags')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        return NextResponse.json({ tag });
    } catch (error) {
        console.error('Error updating tag:', error);
        return NextResponse.json(
            { error: 'Failed to update tag', message: (error as Error).message },
            { status: 500 }
        );
    }
}

// DELETE /api/tags - Delete a single tag
export async function DELETE(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const searchParams = request.nextUrl.searchParams;
        const id = searchParams.get('id');

        if (!id) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Tag ID is required' },
                { status: 400 }
            );
        }

        const supabase = getSupabaseAdmin();

        // Get tag and verify permission
        const { data: existingTag } = await supabase
            .from('tags')
            .select('*')
            .eq('id', id)
            .single();

        if (!existingTag) {
            return NextResponse.json(
                { error: 'Not Found', message: 'Tag not found' },
                { status: 404 }
            );
        }

        // Same permission check as PUT
        let hasPermission = false;
        if (existingTag.owner_type === 'user' && existingTag.owner_id === session.user.id) {
            hasPermission = true;
        } else if (existingTag.owner_type === 'page') {
            const { data: userPage } = await supabase
                .from('user_pages')
                .select('page_id')
                .eq('user_id', session.user.id)
                .eq('page_id', existingTag.owner_id)
                .single();
            hasPermission = !!userPage;
        } else if (existingTag.owner_type === 'business') {
            const { data: businessUser } = await supabase
                .from('business_users')
                .select('business_id')
                .eq('user_id', session.user.id)
                .eq('business_id', existingTag.owner_id)
                .single();
            hasPermission = !!businessUser;
        }

        if (!hasPermission) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have permission to delete this tag' },
                { status: 403 }
            );
        }

        // Delete contact_tags first
        await supabase
            .from('contact_tags')
            .delete()
            .eq('tag_id', id);

        // Delete tag
        const { error } = await supabase
            .from('tags')
            .delete()
            .eq('id', id);

        if (error) throw error;

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error deleting tag:', error);
        return NextResponse.json(
            { error: 'Failed to delete tag', message: (error as Error).message },
            { status: 500 }
        );
    }
}
