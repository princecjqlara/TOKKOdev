import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { recordPageActivity } from '@/lib/activity-history';
import { chunkArray } from '@/lib/chunking';
import { SUPABASE_IN_FILTER_BATCH_SIZE } from '@/lib/supabase-pagination';

function normalizeIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean))];
}

type AssignableTag = {
    id: string;
    owner_type: string;
    owner_id: string;
    page_id: string | null;
    is_shared: boolean;
};

async function getAssignableTagIds(params: {
    supabase: ReturnType<typeof getSupabaseAdmin>;
    userId: string;
    pageId: string;
    tagIds: string[];
}): Promise<Set<string>> {
    const { supabase, userId, pageId, tagIds } = params;
    const tags: AssignableTag[] = [];

    for (const tagIdBatch of chunkArray(tagIds, SUPABASE_IN_FILTER_BATCH_SIZE)) {
        const { data, error } = await supabase
            .from('tags')
            .select('id,owner_type,owner_id,page_id,is_shared')
            .in('id', tagIdBatch);

        if (error) throw error;
        tags.push(...((data || []) as AssignableTag[]));
    }

    const businessOwnerIds = normalizeIds(
        tags.filter((tag) => tag.owner_type === 'business').map((tag) => tag.owner_id)
    );
    const accessibleBusinessIds = new Set<string>();

    if (businessOwnerIds.length > 0) {
        const { data, error } = await supabase
            .from('business_users')
            .select('business_id')
            .eq('user_id', userId)
            .in('business_id', businessOwnerIds);

        if (error) throw error;
        for (const row of data || []) accessibleBusinessIds.add(row.business_id);
    }

    const sharedPersonalTagIds = tags
        .filter((tag) =>
            tag.owner_type === 'user' &&
            tag.owner_id !== userId &&
            tag.page_id === pageId &&
            tag.is_shared
        )
        .map((tag) => tag.id);
    const shareRecipientsByTagId = new Map<string, Set<string>>();

    if (sharedPersonalTagIds.length > 0) {
        const { data, error } = await supabase
            .from('tag_shares')
            .select('tag_id,shared_with_user_id')
            .in('tag_id', sharedPersonalTagIds);

        if (error) throw error;
        for (const row of data || []) {
            const recipients = shareRecipientsByTagId.get(row.tag_id) || new Set<string>();
            recipients.add(row.shared_with_user_id);
            shareRecipientsByTagId.set(row.tag_id, recipients);
        }
    }

    return new Set(tags.filter((tag) => {
        if (tag.owner_type === 'page') {
            return tag.owner_id === pageId;
        }

        if (tag.owner_type === 'user') {
            if (tag.page_id !== pageId) return false;
            if (tag.owner_id === userId) return true;
            if (!tag.is_shared) return false;

            // No explicit recipients means the tag is shared with the full
            // page team. Otherwise it must target the current user.
            const recipients = shareRecipientsByTagId.get(tag.id);
            return !recipients || recipients.has(userId);
        }

        return tag.owner_type === 'business' && accessibleBusinessIds.has(tag.owner_id);
    }).map((tag) => tag.id));
}

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
        const contactIds = normalizeIds(body.contactIds);
        const tagIds = normalizeIds(body.tagIds);

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

        const assignableTagIds = await getAssignableTagIds({
            supabase,
            userId: session.user.id,
            pageId,
            tagIds
        });
        const inaccessibleTagIds = tagIds.filter((tagId) => !assignableTagIds.has(tagId));

        if (inaccessibleTagIds.length > 0) {
            return NextResponse.json(
                {
                    error: 'Bad Request',
                    message: 'One or more tags are not available for this page'
                },
                { status: 400 }
            );
        }

        // Verify contacts belong to this page
        const validContactIds: string[] = [];
        for (const contactIdBatch of chunkArray(contactIds, SUPABASE_IN_FILTER_BATCH_SIZE)) {
            const { data: validContacts, error: validContactsError } = await supabase
                .from('contacts')
                .select('id')
                .in('id', contactIdBatch)
                .eq('page_id', pageId);

            if (validContactsError) throw validContactsError;
            validContactIds.push(...(validContacts || []).map((contact) => contact.id));
        }

        // Create contact_tags entries
        const entries = [];
        for (const contactId of validContactIds) {
            for (const tagId of tagIds) {
                entries.push({
                    contact_id: contactId,
                    tag_id: tagId,
                    created_by: session.user.id
                });
            }
        }

        if (entries.length > 0) {
            // Use upsert to avoid duplicates
            for (const entryBatch of chunkArray(entries, 500)) {
                const { error } = await supabase
                    .from('contact_tags')
                    .upsert(entryBatch, {
                        onConflict: 'contact_id,tag_id',
                        ignoreDuplicates: true
                    });

                if (error) throw error;
            }
        }

        await recordPageActivity(supabase, {
            pageId,
            actorUserId: session.user.id,
            actionType: 'bulk_tags_added',
            entityType: 'contacts',
            summary: `Added ${tagIds.length} tag${tagIds.length === 1 ? '' : 's'} to ${validContactIds.length} contact${validContactIds.length === 1 ? '' : 's'}`,
            targetCount: validContactIds.length,
            successCount: validContactIds.length,
            details: {
                requestedContactCount: contactIds.length,
                matchedContactCount: validContactIds.length,
                tagCount: tagIds.length,
                assignmentCount: entries.length,
                tagIds: tagIds.slice(0, 100),
                contactIds: validContactIds.slice(0, 100),
                tagListTruncated: tagIds.length > 100,
                contactListTruncated: validContactIds.length > 100
            }
        });

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
