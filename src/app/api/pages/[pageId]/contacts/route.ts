import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { PaginatedResponse, Contact } from '@/types';
import { normalizeContactName } from '../../../../../lib/contact-names';

type DateFilterMode = 'include' | 'exclude';

function getDateToEndString(dateTo: string): string {
    const dateToEnd = new Date(dateTo);
    dateToEnd.setDate(dateToEnd.getDate() + 1);
    return dateToEnd.toISOString().split('T')[0];
}

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
        const dateFilterMode: DateFilterMode = searchParams.get('dateFilterMode') === 'exclude'
            ? 'exclude'
            : 'include';

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
            dateTo: dateTo || null,
            dateFilterMode
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

        // Build query — fetch contacts WITHOUT the tag join. The tag join was
        // causing failures on large pages (e.g., "Zeus Media") because the
        // joined response could exceed Supabase row/size limits. Tags are
        // fetched separately below for the page of contacts being returned.
        const tagFilterSelect = [
            tagIds.length > 0 ? 'included_tag_filter:contact_tags!inner()' : '',
            excludeTagIds.length > 0 ? 'excluded_tag_filter:contact_tags!left()' : ''
        ].filter(Boolean).join(',');
        const contactSelect = (tagFilterSelect ? `*,${tagFilterSelect}` : '*') as '*';
        let query = supabase
            .from('contacts')
            .select(contactSelect, { count: 'exact' })
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
        if (dateFilterMode === 'exclude') {
            const outsideRangeConditions = [
                ...(dateFrom
                    ? [
                        `first_interaction_at.lt.${dateFrom}`,
                        `and(first_interaction_at.is.null,created_at.lt.${dateFrom})`
                    ]
                    : []),
                ...(dateTo
                    ? [
                        `first_interaction_at.gte.${getDateToEndString(dateTo)}`,
                        `and(first_interaction_at.is.null,created_at.gte.${getDateToEndString(dateTo)})`
                    ]
                    : [])
            ];

            if (outsideRangeConditions.length > 0) {
                query = query.or(outsideRangeConditions.join(','));
            }
        } else {
            if (dateFrom) {
                query = query.or(`first_interaction_at.gte.${dateFrom},and(first_interaction_at.is.null,created_at.gte.${dateFrom})`);
            }
            if (dateTo) {
                query = query.or(`first_interaction_at.lt.${getDateToEndString(dateTo)},and(first_interaction_at.is.null,created_at.lt.${getDateToEndString(dateTo)})`);
            }
        }

        // Apply include tag filter (OR logic — contacts with ANY of the selected tags)
        if (tagIds.length > 0) {
            query = query.in('included_tag_filter.tag_id', tagIds);
        }

        // Apply exclude tag filter (OR logic — exclude contacts with ANY of the excluded tags)
        if (excludeTagIds.length > 0) {
            query = query
                .in('excluded_tag_filter.tag_id', excludeTagIds)
                .is('excluded_tag_filter', null);
        }

        // Apply pagination
        const from = (page - 1) * pageSize;
        const to = from + pageSize - 1;
        query = query.range(from, to);

        const { data: rawContacts, error, count } = await query;

        if (error) {
            logError('Supabase error fetching contacts', {
                pageId,
                code: (error as { code?: string }).code,
                message: error.message,
                details: (error as { details?: string }).details,
                hint: (error as { hint?: string }).hint
            });
            throw error;
        }

        // Fetch tag relations only for the contacts on this page of results.
        const pageContactIds = (rawContacts || []).map((c) => c.id).filter((id): id is string => typeof id === 'string');
        const tagsByContact = new Map<string, { tag_id: string; created_by: string | null; tags: Record<string, unknown> }[]>();

        if (pageContactIds.length > 0) {
            const { data: tagRows, error: tagError } = await supabase
                .from('contact_tags')
                .select('contact_id, tag_id, created_by, tags(*)')
                .in('contact_id', pageContactIds);

            if (tagError) {
                logWarn('Failed to fetch contact tags — returning contacts without tags', {
                    pageId,
                    message: tagError.message
                });
            } else {
                for (const row of tagRows || []) {
                    const list = tagsByContact.get(row.contact_id) || [];
                    const tagsField = (row as { tags?: unknown }).tags;
                    const tagsObj = tagsField && typeof tagsField === 'object' && !Array.isArray(tagsField)
                        ? (tagsField as Record<string, unknown>)
                        : Array.isArray(tagsField) ? (tagsField[0] as Record<string, unknown>) || {} : {};
                    list.push({
                        tag_id: row.tag_id,
                        created_by: row.created_by ?? null,
                        tags: tagsObj
                    });
                    tagsByContact.set(row.contact_id, list);
                }
            }
        }

        const contacts = (rawContacts || []).map((c) => ({
            ...c,
            contact_tags: tagsByContact.get(c.id) || []
        }));

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
