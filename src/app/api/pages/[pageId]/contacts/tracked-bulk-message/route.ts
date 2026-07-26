import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { serializeCampaignMessageSequence } from '@/lib/campaign-message-sequence';
import { chunkArray } from '@/lib/chunking';
import { sendCampaignById } from '@/lib/campaign-send';
import { getSupabaseAdmin } from '@/lib/supabase';
import { fetchAllSupabaseRows } from '@/lib/supabase-pagination';

export const maxDuration = 300;

const ENVELOPE_TEMPLATE_MAP: Record<string, string> = {
    msg: 'general_msg_v1',
    notice: 'general_notice_v1',
    alert: 'general_alert_v1',
    btn_join: 'instant_meeting_btn_v1',
    btn_details: 'instant_meeting_btn_v2',
    btn_book: 'instant_meeting_btn_v3',
    friendly_1: 'friendly_msg_v1',
    friendly_2: 'friendly_msg_v2',
    friendly_3: 'friendly_msg_v3',
    friendly_4: 'friendly_msg_v4',
    friendly_5: 'friendly_msg_v5',
    friendly_6: 'friendly_msg_v6',
    casual_1: 'casual_update_v1',
    casual_2: 'casual_update_v3',
    casual_3: 'casual_update_v4',
    simple_1: 'simple_msg_v4'
};

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [
        ...new Set(
            value
                .map((item) => (typeof item === 'string' ? item.trim() : ''))
                .filter(Boolean)
        )
    ];
}

function normalizeDateFilter(value: unknown): string {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizePositiveInteger(value: unknown, fallback: number | null = null): number | null {
    const numberValue = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : NaN;

    if (!Number.isFinite(numberValue)) {
        return fallback;
    }

    const normalized = Math.floor(numberValue);
    return normalized > 0 ? normalized : fallback;
}

async function getTaggedContactIdSet(
    supabase: ReturnType<typeof getSupabaseAdmin>,
    pageId: string,
    tagIds: string[]
) {
    if (tagIds.length === 0) return null;

    const rows = await fetchAllSupabaseRows<{ contact_id?: string | null }>(
        supabase
            .from('contact_tags')
            .select('contact_id, contacts!inner(page_id)')
            .in('tag_id', tagIds)
            .eq('contacts.page_id', pageId)
    );

    return new Set(
        rows
            .map((row) => row.contact_id)
            .filter((contactId): contactId is string => typeof contactId === 'string' && contactId.trim() !== '')
    );
}

async function resolveAllMatchingContactIds({
    supabase,
    pageId,
    filters,
    excludedContactIds
}: {
    supabase: ReturnType<typeof getSupabaseAdmin>;
    pageId: string;
    filters: Record<string, unknown>;
    excludedContactIds: string[];
}) {
    const search = typeof filters.search === 'string' ? filters.search.trim() : '';
    const includeTagIds = normalizeStringArray(filters.tagIds);
    const excludeTagIds = normalizeStringArray(filters.excludeTagIds);
    const dateFrom = normalizeDateFilter(filters.dateFrom);
    const dateTo = normalizeDateFilter(filters.dateTo);

    let query = supabase
        .from('contacts')
        .select('id')
        .eq('page_id', pageId)
        .not('psid', 'is', null)
        .neq('psid', '')
        .order('last_interaction_at', { ascending: false, nullsFirst: false });

    if (search) {
        query = query.ilike('name', `%${search}%`);
    }

    if (dateFrom) {
        query = query.or(`first_interaction_at.gte.${dateFrom},and(first_interaction_at.is.null,created_at.gte.${dateFrom})`);
    }

    if (dateTo) {
        const dateToEnd = new Date(dateTo);
        dateToEnd.setDate(dateToEnd.getDate() + 1);
        const dateToEndStr = dateToEnd.toISOString().split('T')[0];
        query = query.or(`first_interaction_at.lt.${dateToEndStr},and(first_interaction_at.is.null,created_at.lt.${dateToEndStr})`);
    }

    const [contactRows, includeTagSet, excludeTagSet] = await Promise.all([
        fetchAllSupabaseRows<{ id?: string | null }>(query),
        getTaggedContactIdSet(supabase, pageId, includeTagIds),
        getTaggedContactIdSet(supabase, pageId, excludeTagIds)
    ]);

    const excludedSet = new Set(excludedContactIds);
    return [
        ...new Set(
            contactRows
                .map((row) => row.id)
                .filter((contactId): contactId is string => {
                    if (typeof contactId !== 'string' || contactId.trim() === '') return false;
                    if (includeTagSet && !includeTagSet.has(contactId)) return false;
                    if (excludeTagSet && excludeTagSet.has(contactId)) return false;
                    if (excludedSet.has(contactId)) return false;
                    return true;
                })
        )
    ];
}

async function resolveSpecificContactIds({
    supabase,
    pageId,
    contactIds
}: {
    supabase: ReturnType<typeof getSupabaseAdmin>;
    pageId: string;
    contactIds: string[];
}) {
    const resolved: string[] = [];

    for (const batch of chunkArray(contactIds, 1000)) {
        const { data, error } = await supabase
            .from('contacts')
            .select('id')
            .eq('page_id', pageId)
            .not('psid', 'is', null)
            .neq('psid', '')
            .in('id', batch);

        if (error) {
            throw error;
        }

        resolved.push(
            ...((data || [])
                .map((row) => row.id)
                .filter((contactId): contactId is string => typeof contactId === 'string' && contactId.trim() !== ''))
        );
    }

    return [...new Set(resolved)];
}

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
        const messagePart1 = typeof body.messagePart1 === 'string' ? body.messagePart1.trim() : '';
        const messagePart2 = typeof body.messagePart2 === 'string' ? body.messagePart2.trim() : '';
        const messageText = [messagePart1, messagePart2].filter(Boolean).join('\n\n');
        const envelopeWrapper = typeof body.envelopeWrapper === 'string' ? body.envelopeWrapper : 'msg';
        const requestedTemplateName = typeof body.templateName === 'string' && body.templateName.trim()
            ? body.templateName.trim()
            : null;
        const templateLanguage = typeof body.templateLanguage === 'string' && body.templateLanguage.trim()
            ? body.templateLanguage.trim()
            : 'en_US';

        if (!messageText) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Message text is required' },
                { status: 400 }
            );
        }

        const templateName =
            envelopeWrapper === 'template'
                ? requestedTemplateName
                : envelopeWrapper === 'none'
                    ? null
                    : ENVELOPE_TEMPLATE_MAP[envelopeWrapper] || null;

        if (envelopeWrapper === 'template' && !templateName) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Pick an approved template before sending.' },
                { status: 400 }
            );
        }

        const supabase = getSupabaseAdmin();

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

        const selection = body.selection && typeof body.selection === 'object'
            ? body.selection as Record<string, unknown>
            : {};
        const selectionMode = selection.mode === 'all' ? 'all' : 'specific';
        const resolvedContactIds = selectionMode === 'all'
            ? await resolveAllMatchingContactIds({
                supabase,
                pageId,
                filters: selection.filters && typeof selection.filters === 'object'
                    ? selection.filters as Record<string, unknown>
                    : {},
                excludedContactIds: normalizeStringArray(selection.excludedContactIds)
            })
            : await resolveSpecificContactIds({
                supabase,
                pageId,
                contactIds: normalizeStringArray(selection.contactIds)
            });
        const totalMatched = resolvedContactIds.length;
        const slice = selection.slice && typeof selection.slice === 'object'
            ? selection.slice as Record<string, unknown>
            : null;
        const batchSize = slice ? normalizePositiveInteger(slice.limit) : null;
        const batchNumber = slice ? normalizePositiveInteger(slice.batchNumber, 1) : null;
        const offset = batchSize && batchNumber ? (batchNumber - 1) * batchSize : 0;
        const contactIds = batchSize
            ? resolvedContactIds.slice(offset, offset + batchSize)
            : resolvedContactIds;
        const selectedRange = batchSize
            ? {
                batchSize,
                batchNumber,
                start: totalMatched === 0 ? 0 : offset + 1,
                end: Math.min(offset + batchSize, totalMatched),
                totalMatched
            }
            : null;

        if (contactIds.length === 0) {
            return NextResponse.json(
                {
                    error: 'Bad Request',
                    message: selectedRange
                        ? `No sendable contacts found for batch ${selectedRange.batchNumber}. ${totalMatched} contacts matched the selection.`
                        : 'No sendable contacts matched this selection.'
                },
                { status: 400 }
            );
        }

        const { data: campaign, error: campaignError } = await supabase
            .from('campaigns')
            .insert({
                page_id: pageId,
                name: typeof body.name === 'string' && body.name.trim()
                    ? body.name.trim()
                    : `Bulk message ${new Date().toISOString()}`,
                message_text: serializeCampaignMessageSequence([messageText]),
                status: 'draft',
                total_recipients: contactIds.length,
                sent_count: 0,
                failed_count: 0,
                created_by: session.user.id,
                audience_mode: 'specific',
                use_best_time: false,
                is_loop: false,
                loop_status: 'stopped',
                use_ai_message: false,
                template_name: templateName,
                template_language: templateName ? templateLanguage : null,
                recurrence: 'none'
            })
            .select()
            .single();

        if (campaignError) {
            throw campaignError;
        }

        for (const batch of chunkArray(contactIds, 500)) {
            const { error } = await supabase
                .from('campaign_recipients')
                .insert(batch.map((contactId) => ({
                    campaign_id: campaign.id,
                    contact_id: contactId,
                    status: 'pending'
                })));

            if (error) {
                throw error;
            }
        }

        const sendResult = await sendCampaignById({
            campaignId: campaign.id,
            supabase,
            userId: session.user.id,
            sendBatchSize: 20,
            delayBetweenBatchesMs: 50,
            maxProcessingTimeMs: 240000
        });

        return NextResponse.json({
            success: true,
            campaign,
            recipients: contactIds.length,
            totalMatched,
            selectedRange,
            send: sendResult.body
        });
    } catch (error) {
        console.error('Error creating tracked bulk message:', error);
        return NextResponse.json(
            { error: 'Failed to create tracked bulk message', message: (error as Error).message },
            { status: 500 }
        );
    }
}
