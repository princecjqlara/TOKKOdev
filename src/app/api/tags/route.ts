import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { PaginatedResponse, Tag } from '@/types';

function normalizeUserIdList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const ids = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);

    return Array.from(new Set(ids));
}

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

        const currentUserId = session.user.id;

        const searchParams = request.nextUrl.searchParams;
        const page = parseInt(searchParams.get('page') || '1');
        const pageSize = parseInt(searchParams.get('pageSize') || '50');
        const scope = searchParams.get('scope') || 'all'; // user, page, business, all
        const pageId = searchParams.get('pageId') || '';

        const supabase = getSupabaseAdmin();

        if (!['user', 'page', 'business', 'all'].includes(scope)) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Invalid tag scope' },
                { status: 400 }
            );
        }

        if (scope === 'page') {
            if (!pageId) {
                return NextResponse.json(
                    { error: 'Bad Request', message: 'pageId is required for page tags' },
                    { status: 400 }
                );
            }

            const { data: userPage, error: userPageError } = await supabase
                .from('user_pages')
                .select('page_id')
                .eq('user_id', currentUserId)
                .eq('page_id', pageId)
                .single();

            if (userPageError || !userPage) {
                return NextResponse.json(
                    { error: 'Forbidden', message: 'You do not have access to this page' },
                    { status: 403 }
                );
            }
        }

        // Build query based on scope
        let query = supabase
            .from('tags')
            .select('*', { count: 'exact' })
            .order('name');

        if (scope === 'user') {
            query = query.eq('owner_type', 'user').eq('owner_id', currentUserId);
        } else if (scope === 'page' && pageId) {
            query = query.eq('owner_type', 'page').eq('owner_id', pageId);
        } else if (scope === 'business') {
            // Get user's business IDs
            const { data: businessUsers } = await supabase
                .from('business_users')
                .select('business_id')
                .eq('user_id', currentUserId);

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
                .eq('user_id', currentUserId);

            const { data: businessUsers } = await supabase
                .from('business_users')
                .select('business_id')
                .eq('user_id', currentUserId);

            const pageIds = userPages?.map(up => up.page_id) || [];
            const businessIds = businessUsers?.map(bu => bu.business_id) || [];
            const accessiblePageIds = pageId
                ? pageIds.filter((id) => id === pageId)
                : pageIds;

            // Use multiple queries and combine results instead of complex OR
            const allTags: Tag[] = [];

            // Get user's own tags
            let userTagsQuery = supabase
                .from('tags')
                .select('*')
                .eq('owner_type', 'user')
                .eq('owner_id', currentUserId);

            if (pageId) {
                userTagsQuery = userTagsQuery.eq('page_id', pageId);
            }

            const { data: userTags } = await userTagsQuery;
            if (userTags) allTags.push(...userTags);

            // Get page tags
            if (accessiblePageIds.length > 0) {
                const { data: pageTags } = await supabase
                    .from('tags')
                    .select('*')
                    .eq('owner_type', 'page')
                    .in('owner_id', accessiblePageIds);
                if (pageTags) allTags.push(...pageTags);
            }

            // Get personal tags shared by teammates on the same page(s)
            if (accessiblePageIds.length > 0) {
                const { data: sharedPersonalTags } = await supabase
                    .from('tags')
                    .select('*')
                    .eq('owner_type', 'user')
                    .eq('is_shared', true)
                    .neq('owner_id', currentUserId)
                    .in('page_id', accessiblePageIds);

                let visibleSharedPersonalTags = sharedPersonalTags || [];

                if (visibleSharedPersonalTags.length > 0) {
                    const sharedTagIds = visibleSharedPersonalTags.map((tag) => tag.id);
                    const { data: shareRows, error: shareRowsError } = await supabase
                        .from('tag_shares')
                        .select('tag_id,shared_with_user_id')
                        .in('tag_id', sharedTagIds);

                    if (shareRowsError) throw shareRowsError;

                    const sharesByTagId = new Map<string, string[]>();
                    for (const row of shareRows || []) {
                        const existing = sharesByTagId.get(row.tag_id) || [];
                        existing.push(row.shared_with_user_id);
                        sharesByTagId.set(row.tag_id, existing);
                    }

                    visibleSharedPersonalTags = visibleSharedPersonalTags.filter((tag) => {
                        const recipients = sharesByTagId.get(tag.id) || [];
                        if (recipients.length === 0) {
                            return true;
                        }

                        return recipients.includes(currentUserId);
                    });
                }

                allTags.push(...visibleSharedPersonalTags);
            }

            // Get business tags
            if (businessIds.length > 0) {
                const { data: bizTags } = await supabase
                    .from('tags')
                    .select('*')
                    .eq('owner_type', 'business')
                    .in('owner_id', businessIds);
                if (bizTags) allTags.push(...bizTags);
            }

            // Remove duplicates, sort by name, and apply pagination
            const uniqueTags = Array.from(
                new Map(allTags.map((tag) => [tag.id, tag])).values()
            );

            uniqueTags.sort((a, b) => a.name.localeCompare(b.name));
            const from = (page - 1) * pageSize;
            let paginatedTags = uniqueTags.slice(from, from + pageSize);

            const ownSharedTagIds = paginatedTags
                .filter(
                    (tag) =>
                        tag.owner_type === 'user' &&
                        tag.owner_id === currentUserId &&
                        tag.is_shared === true
                )
                .map((tag) => tag.id);

            if (ownSharedTagIds.length > 0) {
                const { data: ownShareRows, error: ownShareRowsError } = await supabase
                    .from('tag_shares')
                    .select('tag_id,shared_with_user_id')
                    .in('tag_id', ownSharedTagIds);

                if (ownShareRowsError) throw ownShareRowsError;

                const sharedWithByTagId = new Map<string, string[]>();
                for (const row of ownShareRows || []) {
                    const existing = sharedWithByTagId.get(row.tag_id) || [];
                    existing.push(row.shared_with_user_id);
                    sharedWithByTagId.set(row.tag_id, existing);
                }

                paginatedTags = paginatedTags.map((tag) => {
                    if (
                        tag.owner_type === 'user' &&
                        tag.owner_id === currentUserId &&
                        tag.is_shared === true
                    ) {
                        return {
                            ...tag,
                            shared_with_user_ids: sharedWithByTagId.get(tag.id) || []
                        };
                    }

                    return tag;
                });
            }

            return NextResponse.json({
                items: paginatedTags,
                page,
                pageSize,
                total: uniqueTags.length,
                tags: paginatedTags // For backwards compatibility
            } as PaginatedResponse<Tag>);
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
            total: count || 0,
            tags: tags || [] // For backwards compatibility
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

        const currentUserId = session.user.id;

        const body = await request.json();
        const { name, color, ownerType, ownerId, pageId, isShared, sharedWithUserIds } = body;
        const normalizedName = typeof name === 'string' ? name.trim() : '';

        if (!normalizedName || !ownerType || !ownerId) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Name, ownerType, and ownerId are required' },
                { status: 400 }
            );
        }

        const supabase = getSupabaseAdmin();

        if (!['user', 'page', 'business'].includes(ownerType)) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Invalid tag owner type' },
                { status: 400 }
            );
        }

        const shouldShareWithPage = ownerType === 'user' && isShared === true;
        const normalizedShareTargets = normalizeUserIdList(sharedWithUserIds)
            .filter((id) => id !== currentUserId);

        // Verify ownership permission
        if (ownerType === 'page') {
            const { data: userPage } = await supabase
                .from('user_pages')
                .select('page_id')
                .eq('user_id', currentUserId)
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
                .eq('user_id', currentUserId)
                .eq('business_id', ownerId)
                .single();

            if (!businessUser) {
                return NextResponse.json(
                    { error: 'Forbidden', message: 'You do not have access to this business' },
                    { status: 403 }
                );
            }
        } else if (ownerType === 'user' && ownerId !== currentUserId) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'Cannot create tags for other users' },
                { status: 403 }
            );
        }

        if (ownerType === 'user' && pageId) {
            const { data: userPage } = await supabase
                .from('user_pages')
                .select('page_id')
                .eq('user_id', currentUserId)
                .eq('page_id', pageId)
                .single();

            if (!userPage) {
                return NextResponse.json(
                    { error: 'Forbidden', message: 'You do not have access to this page' },
                    { status: 403 }
                );
            }
        }

        if (shouldShareWithPage) {
            if (!pageId) {
                return NextResponse.json(
                    { error: 'Bad Request', message: 'pageId is required when sharing a personal tag' },
                    { status: 400 }
                );
            }

            if (normalizedShareTargets.length > 0) {
                const { data: validShareTargets, error: validShareTargetsError } = await supabase
                    .from('user_pages')
                    .select('user_id')
                    .eq('page_id', pageId)
                    .in('user_id', normalizedShareTargets);

                if (validShareTargetsError) throw validShareTargetsError;

                const validTargetIds = new Set(validShareTargets?.map((row) => row.user_id) || []);
                const invalidTargetIds = normalizedShareTargets.filter((id) => !validTargetIds.has(id));

                if (invalidTargetIds.length > 0) {
                    return NextResponse.json(
                        {
                            error: 'Bad Request',
                            message: 'Some selected team members do not belong to this page'
                        },
                        { status: 400 }
                    );
                }
            }
        }

        const { data: tag, error } = await supabase
            .from('tags')
            .insert({
                name: normalizedName,
                color: color || '#6366f1',
                owner_type: ownerType,
                owner_id: ownerId,
                // A page-owned tag always belongs to its owner page. Do not
                // trust a second, potentially mismatched pageId from clients.
                page_id: ownerType === 'page' ? ownerId : pageId || null,
                is_shared: shouldShareWithPage
            })
            .select()
            .single();

        if (error) throw error;

        if (shouldShareWithPage && normalizedShareTargets.length > 0) {
            const { error: shareError } = await supabase
                .from('tag_shares')
                .upsert(
                    normalizedShareTargets.map((userId: string) => ({
                        tag_id: tag.id,
                        shared_with_user_id: userId
                    })),
                    {
                        onConflict: 'tag_id,shared_with_user_id',
                        ignoreDuplicates: true
                    }
                );

            if (shareError) throw shareError;
        }

        return NextResponse.json({
            tag: {
                ...tag,
                shared_with_user_ids: shouldShareWithPage ? normalizedShareTargets : []
            }
        });
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

        const currentUserId = session.user.id;

        const body = await request.json();
        const { id, name, color, isShared, sharedWithUserIds } = body;

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
        if (existingTag.owner_type === 'user' && existingTag.owner_id === currentUserId) {
            hasPermission = true;
        } else if (existingTag.owner_type === 'page') {
            const { data: userPage } = await supabase
                .from('user_pages')
                .select('page_id')
                .eq('user_id', currentUserId)
                .eq('page_id', existingTag.owner_id)
                .single();
            hasPermission = !!userPage;
        } else if (existingTag.owner_type === 'business') {
            const { data: businessUser } = await supabase
                .from('business_users')
                .select('business_id')
                .eq('user_id', currentUserId)
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

        const updates: { name?: string; color?: string; is_shared?: boolean } = {};
        if (name) updates.name = name;
        if (color) updates.color = color;

        const shouldUpdateShareTargets = Array.isArray(sharedWithUserIds);
        const normalizedShareTargets = normalizeUserIdList(sharedWithUserIds)
            .filter((userId) => userId !== currentUserId);
        const nextIsShared =
            typeof isShared === 'boolean'
                ? isShared
                : Boolean(existingTag.is_shared);

        if (typeof isShared === 'boolean') {
            if (existingTag.owner_type !== 'user') {
                return NextResponse.json(
                    { error: 'Bad Request', message: 'Sharing is only available for personal tags' },
                    { status: 400 }
                );
            }

            if (nextIsShared) {
                if (!existingTag.page_id) {
                    return NextResponse.json(
                        {
                            error: 'Bad Request',
                            message: 'A personal tag must be connected to a page before it can be shared'
                        },
                        { status: 400 }
                    );
                }

                const { data: userPage } = await supabase
                    .from('user_pages')
                    .select('page_id')
                    .eq('user_id', currentUserId)
                    .eq('page_id', existingTag.page_id)
                    .single();

                if (!userPage) {
                    return NextResponse.json(
                        { error: 'Forbidden', message: 'You do not have access to this page' },
                        { status: 403 }
                    );
                }
            }

            updates.is_shared = nextIsShared;
        }

        if (shouldUpdateShareTargets && existingTag.owner_type !== 'user') {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Share targets are only available for personal tags' },
                { status: 400 }
            );
        }

        if (shouldUpdateShareTargets && nextIsShared) {
            if (!existingTag.page_id) {
                return NextResponse.json(
                    {
                        error: 'Bad Request',
                        message: 'A personal tag must be connected to a page before it can be shared'
                    },
                    { status: 400 }
                );
            }

            if (normalizedShareTargets.length > 0) {
                const { data: validShareTargets, error: validShareTargetsError } = await supabase
                    .from('user_pages')
                    .select('user_id')
                    .eq('page_id', existingTag.page_id)
                    .in('user_id', normalizedShareTargets);

                if (validShareTargetsError) throw validShareTargetsError;

                const validTargetIds = new Set(validShareTargets?.map((row) => row.user_id) || []);
                const invalidTargetIds = normalizedShareTargets.filter((userId) => !validTargetIds.has(userId));

                if (invalidTargetIds.length > 0) {
                    return NextResponse.json(
                        {
                            error: 'Bad Request',
                            message: 'Some selected team members do not belong to this page'
                        },
                        { status: 400 }
                    );
                }
            }
        }

        const { data: tag, error } = await supabase
            .from('tags')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        const shouldClearShareTargets = existingTag.owner_type === 'user' && (
            shouldUpdateShareTargets ||
            (typeof isShared === 'boolean' && !nextIsShared)
        );

        if (shouldClearShareTargets) {
            const { error: clearShareError } = await supabase
                .from('tag_shares')
                .delete()
                .eq('tag_id', id);

            if (clearShareError) throw clearShareError;

            if (nextIsShared && normalizedShareTargets.length > 0) {
                const { error: addShareError } = await supabase
                    .from('tag_shares')
                    .upsert(
                        normalizedShareTargets.map((userId) => ({
                            tag_id: id,
                            shared_with_user_id: userId
                        })),
                        {
                            onConflict: 'tag_id,shared_with_user_id',
                            ignoreDuplicates: true
                        }
                    );

                if (addShareError) throw addShareError;
            }
        }

        return NextResponse.json({
            tag: {
                ...tag,
                ...(shouldUpdateShareTargets
                    ? { shared_with_user_ids: nextIsShared ? normalizedShareTargets : [] }
                    : {})
            }
        });
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

        const currentUserId = session.user.id;

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
        if (existingTag.owner_type === 'user' && existingTag.owner_id === currentUserId) {
            hasPermission = true;
        } else if (existingTag.owner_type === 'page') {
            const { data: userPage } = await supabase
                .from('user_pages')
                .select('page_id')
                .eq('user_id', currentUserId)
                .eq('page_id', existingTag.owner_id)
                .single();
            hasPermission = !!userPage;
        } else if (existingTag.owner_type === 'business') {
            const { data: businessUser } = await supabase
                .from('business_users')
                .select('business_id')
                .eq('user_id', currentUserId)
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
