import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { PaginatedResponse, Contact } from '@/types';
import { buildNotInFilter } from '@/lib/tag-filters';
import { normalizeContactName } from '../../../../../lib/contact-names';

// GET /api/pages/[pageId]/contacts - Get contacts with pagination
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const logPrefix = `[CONTACTS_GET][${requestId}]`;
    const logInfo = (message: string, data?: unknown) => {
        if (data !== undefined) {
            console.log(`${logPrefix} ${message}`, data);
            return;
        }
        console.log(`${logPrefix} ${message}`);
    };
    const logWarn = (message: string, data?: unknown) => {
        if (data !== undefined) {
            console.warn(`${logPrefix} ${message}`, data);
            return;
        }
        console.warn(`${logPrefix} ${message}`);
    };
    const logError = (message: string, data?: unknown) => {
        if (data !== undefined) {
            console.error(`${logPrefix} ${message}`, data);
            return;
        }
        console.error(`${logPrefix} ${message}`);
    };

    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            logWarn('Unauthorized contacts request');
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
        // Support both multi-tag (comma-separated) and legacy single-tag params
        const tagIdsRaw = searchParams.get('tagIds') || searchParams.get('tagId') || '';
        const excludeTagIdsRaw = searchParams.get('excludeTagIds') || searchParams.get('excludeTagId') || '';
        const tagIds = tagIdsRaw ? tagIdsRaw.split(',').filter(Boolean) : [];
        const excludeTagIds = excludeTagIdsRaw ? excludeTagIdsRaw.split(',').filter(Boolean) : [];
        const sendableOnly = searchParams.get('sendable') === 'true'; // Only return contacts with valid PSIDs
        const dateFrom = searchParams.get('dateFrom') || '';
        const dateTo = searchParams.get('dateTo') || '';

        logInfo('Contacts request received', {
            userId: session.user.id,
            pageId,
            page,
            pageSize,
            hasSearch: Boolean(search),
            searchLength: search.length,
            includeTagCount: tagIds.length,
            excludeTagCount: excludeTagIds.length,
            sendableOnly,
            dateFrom: dateFrom || null,
            dateTo: dateTo || null
        });

        const supabase = getSupabaseAdmin();

        // Verify user has access to page
        const { data: userPage } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', session.user.id)
            .eq('page_id', pageId)
            .single();

        if (!userPage) {
            logWarn('User attempted contacts request for page without access', {
                userId: session.user.id,
                pageId
            });
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this page' },
                { status: 403 }
            );
        }

        // Build query
        let query = supabase
            .from('contacts')
            .select('*, contact_tags(tag_id, created_by, tags(*))', { count: 'exact' })
            .eq('page_id', pageId)
            .order('last_interaction_at', { ascending: false, nullsFirst: false });

        // Filter for sendable contacts only (those with valid PSIDs)
        if (sendableOnly) {
            query = query.not('psid', 'is', null).neq('psid', '');
        }

        // Apply search filter
        if (search) {
            query = query.ilike('name', `%${search}%`);
        }

        // Apply date range filter on first_interaction_at (falls back to created_at)
        if (dateFrom) {
            query = query.or(`first_interaction_at.gte.${dateFrom},and(first_interaction_at.is.null,created_at.gte.${dateFrom})`);
        }
        if (dateTo) {
            // Add one day to dateTo to include the entire day
            const dateToEnd = new Date(dateTo);
            dateToEnd.setDate(dateToEnd.getDate() + 1);
            const dateToEndStr = dateToEnd.toISOString().split('T')[0];
            query = query.or(`first_interaction_at.lt.${dateToEndStr},and(first_interaction_at.is.null,created_at.lt.${dateToEndStr})`);
        }

        // Apply include tag filter (OR logic — contacts with ANY of the selected tags)
        if (tagIds.length > 0) {
            const { data: taggedContacts, error: taggedContactsError } = await supabase
                .from('contact_tags')
                .select('contact_id, contacts!inner(page_id)')
                .in('tag_id', tagIds)
                .eq('contacts.page_id', pageId);

            if (taggedContactsError) throw taggedContactsError;

            // Deduplicate contact IDs (a contact may have multiple matching tags)
            const contactIds = [
                ...new Set(
                    (taggedContacts || [])
                        .map((tc) => tc.contact_id)
                        .filter((contactId): contactId is string => typeof contactId === 'string' && contactId.trim() !== '')
                )
            ];

            if (contactIds.length > 0) {
                query = query.in('id', contactIds);
                logInfo('Applied include-tag filter', {
                    includeTagCount: tagIds.length,
                    matchingContactCount: contactIds.length
                });
            } else {
                // No contacts with any of these tags
                logInfo('Include-tag filter matched no contacts', {
                    includeTagCount: tagIds.length
                });
                return NextResponse.json({
                    items: [],
                    page,
                    pageSize,
                    total: 0
                } as PaginatedResponse<Contact>);
            }
        }

        // Apply exclude tag filter (OR logic — exclude contacts with ANY of the excluded tags)
        if (excludeTagIds.length > 0) {
            const { data: excludedContacts, error: excludedError } = await supabase
                .from('contact_tags')
                .select('contact_id, contacts!inner(page_id)')
                .in('tag_id', excludeTagIds)
                .eq('contacts.page_id', pageId);

            if (excludedError) throw excludedError;

            const excludedIds = [
                ...new Set(
                    (excludedContacts || [])
                        .map((tc) => tc.contact_id)
                        .filter((contactId): contactId is string => typeof contactId === 'string' && contactId.trim() !== '')
                )
            ];
            const notInFilter = buildNotInFilter(excludedIds);
            if (notInFilter) {
                query = query.not('id', 'in', notInFilter);
                logInfo('Applied exclude-tag filter', {
                    excludeTagCount: excludeTagIds.length,
                    excludedContactCount: excludedIds.length
                });
            }
        }

        // Apply pagination
        const from = (page - 1) * pageSize;
        const to = from + pageSize - 1;
        query = query.range(from, to);

        const { data: contacts, error, count } = await query;

        if (error) throw error;

        const taggedByIds = [
            ...new Set(
                (contacts || [])
                    .flatMap((contact) =>
                        (contact.contact_tags || [])
                            .map((ct: { created_by?: string | null }) => ct.created_by)
                            .filter((createdBy: string | null | undefined): createdBy is string => Boolean(createdBy))
                    )
            )
        ];

        const taggedByUsers = new Map<string, { name: string | null; email: string | null }>();
        if (taggedByIds.length > 0) {
            const { data: users, error: usersError } = await supabase
                .from('users')
                .select('id,name,email')
                .in('id', taggedByIds);

            if (usersError) throw usersError;

            for (const user of users || []) {
                taggedByUsers.set(user.id, {
                    name: user.name,
                    email: user.email
                });
            }
        }

        // Transform contacts to include tags array
        const transformedContacts = contacts?.map(contact => ({
            ...contact,
            name: normalizeContactName(contact.name),
            tags: contact.contact_tags?.map((ct: {
                created_by?: string | null;
                tags: Record<string, unknown>;
            }) => {
                const taggedBy = ct.created_by ? taggedByUsers.get(ct.created_by) : undefined;
                const tagData = ct.tags && typeof ct.tags === 'object' ? ct.tags : {};
                return {
                    ...tagData,
                    tagged_by_user_id: ct.created_by || null,
                    tagged_by_name: taggedBy?.name || taggedBy?.email || null
                };
            }) || [],
            contact_tags: undefined
        })) || [];

        logInfo('Returning contacts response', {
            returnedItems: transformedContacts.length,
            totalMatched: count || 0,
            page,
            pageSize,
            firstReturnedContactId: transformedContacts[0]?.id ?? null,
            firstReturnedPsid: transformedContacts[0]?.psid ?? null
        });

        return NextResponse.json({
            items: transformedContacts,
            page,
            pageSize,
            total: count || 0
        } as PaginatedResponse<Contact>);
    } catch (error) {
        logError('Error fetching contacts', {
            error: (error as Error).message
        });
        return NextResponse.json(
            { error: 'Failed to fetch contacts', message: (error as Error).message },
            { status: 500 }
        );
    }
}
