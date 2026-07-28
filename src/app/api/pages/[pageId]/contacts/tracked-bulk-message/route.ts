import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { serializeCampaignMessageSequence } from '@/lib/campaign-message-sequence';
import { chunkArray } from '@/lib/chunking';
import { getPhilippinesScheduledAtIso, getTomorrowPhilippinesDateParts } from '@/lib/philippines-time';
import { sendCampaignById } from '@/lib/campaign-send';
import { getSupabaseAdmin } from '@/lib/supabase';
import { fetchAllSupabaseRows } from '@/lib/supabase-pagination';

export const maxDuration = 300;

type DateFilterMode = 'include' | 'exclude';
type BulkDeliveryMode = 'now' | 'best_time_next_day';

type ContactBestTimeRow = {
    id: string;
    best_contact_hour?: number | null;
    best_contact_hours?: unknown;
};

type BestContactHour = {
    hour: number;
    count?: number;
};

type ScheduledCampaignSummary = {
    id: string;
    messageNumber: number;
    scheduledAt: string;
    scheduledAtPh: string;
    recipients: number;
};

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

function normalizeDateFilterMode(value: unknown): DateFilterMode {
    return value === 'exclude' ? 'exclude' : 'include';
}

function getDateToEndString(dateTo: string): string {
    const dateToEnd = new Date(dateTo);
    dateToEnd.setDate(dateToEnd.getDate() + 1);
    return dateToEnd.toISOString().split('T')[0];
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

function normalizeDeliveryMode(value: unknown): BulkDeliveryMode {
    return value === 'best_time_next_day' ? 'best_time_next_day' : 'now';
}

function normalizeScheduledMessages(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .slice(0, 3)
        .map((message) => (typeof message === 'string' ? message.trim() : ''));
}

function normalizeHour(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isInteger(value)) return null;
    return value >= 0 && value <= 23 ? value : null;
}

function normalizeBestContactHours(contact: ContactBestTimeRow): number[] {
    const hours: number[] = [];

    if (Array.isArray(contact.best_contact_hours)) {
        for (const item of contact.best_contact_hours) {
            if (!item || typeof item !== 'object') continue;
            const hour = normalizeHour((item as BestContactHour).hour);
            if (hour !== null && !hours.includes(hour)) {
                hours.push(hour);
            }
        }
    }

    const fallbackHour = normalizeHour(contact.best_contact_hour);
    if (fallbackHour !== null && !hours.includes(fallbackHour)) {
        hours.push(fallbackHour);
    }

    return hours.slice(0, 3).sort((a, b) => a - b);
}

function formatPhilippinesScheduledAt(iso: string) {
    return new Intl.DateTimeFormat('en-PH', {
        timeZone: 'Asia/Manila',
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    }).format(new Date(iso));
}

async function getBulkScheduleStatus(
    supabase: ReturnType<typeof getSupabaseAdmin>,
    pageId: string,
    campaignIds: string[]
) {
    const uniqueCampaignIds = [...new Set(campaignIds.filter(Boolean))];
    if (uniqueCampaignIds.length === 0) {
        return {
            campaignIds: [],
            total: 0,
            sent: 0,
            failed: 0,
            pending: 0,
            notYetSent: 0,
            allBestTimesSent: false
        };
    }

    const { data: campaigns, error: campaignError } = await supabase
        .from('campaigns')
        .select('id, page_id')
        .eq('page_id', pageId)
        .in('id', uniqueCampaignIds);

    if (campaignError) {
        throw campaignError;
    }

    const allowedCampaignIds = (campaigns || []).map((campaign) => campaign.id);
    if (allowedCampaignIds.length === 0) {
        return {
            campaignIds: [],
            total: 0,
            sent: 0,
            failed: 0,
            pending: 0,
            notYetSent: 0,
            allBestTimesSent: false
        };
    }

    const [totalResult, sentResult, failedResult, pendingResult] = await Promise.all([
        supabase
            .from('campaign_recipients')
            .select('id', { count: 'exact', head: true })
            .in('campaign_id', allowedCampaignIds),
        supabase
            .from('campaign_recipients')
            .select('id', { count: 'exact', head: true })
            .in('campaign_id', allowedCampaignIds)
            .eq('status', 'sent'),
        supabase
            .from('campaign_recipients')
            .select('id', { count: 'exact', head: true })
            .in('campaign_id', allowedCampaignIds)
            .eq('status', 'failed'),
        supabase
            .from('campaign_recipients')
            .select('id', { count: 'exact', head: true })
            .in('campaign_id', allowedCampaignIds)
            .eq('status', 'pending')
    ]);

    const firstError = totalResult.error || sentResult.error || failedResult.error || pendingResult.error;
    if (firstError) {
        throw firstError;
    }

    const total = totalResult.count || 0;
    const sent = sentResult.count || 0;
    const failed = failedResult.count || 0;
    const pending = pendingResult.count || 0;

    return {
        campaignIds: allowedCampaignIds,
        total,
        sent,
        failed,
        pending,
        notYetSent: pending + failed,
        allBestTimesSent: total > 0 && sent === total && failed === 0 && pending === 0
    };
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
    const dateFilterMode = normalizeDateFilterMode(filters.dateFilterMode);

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
        const deliveryMode = normalizeDeliveryMode(body.deliveryMode);
        const messagePart1 = typeof body.messagePart1 === 'string' ? body.messagePart1.trim() : '';
        const messagePart2 = typeof body.messagePart2 === 'string' ? body.messagePart2.trim() : '';
        const messageText = [messagePart1, messagePart2].filter(Boolean).join('\n\n');
        const scheduledMessages = normalizeScheduledMessages(body.scheduledMessages);
        const envelopeWrapper = typeof body.envelopeWrapper === 'string' ? body.envelopeWrapper : 'msg';
        const requestedTemplateName = typeof body.templateName === 'string' && body.templateName.trim()
            ? body.templateName.trim()
            : null;
        const templateLanguage = typeof body.templateLanguage === 'string' && body.templateLanguage.trim()
            ? body.templateLanguage.trim()
            : 'en_US';

        if (deliveryMode === 'now' && !messageText) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Message text is required' },
                { status: 400 }
            );
        }

        if (deliveryMode === 'best_time_next_day' && (scheduledMessages.length !== 3 || scheduledMessages.some((message) => !message))) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Fill up all 3 scheduled messages before using best-time scheduling.' },
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

        if (deliveryMode === 'best_time_next_day') {
            const contactsById = new Map<string, ContactBestTimeRow>();
            for (const batch of chunkArray(contactIds, 1000)) {
                const { data, error } = await supabase
                    .from('contacts')
                    .select('id, best_contact_hour, best_contact_hours')
                    .eq('page_id', pageId)
                    .in('id', batch);

                if (error) {
                    throw error;
                }

                for (const contact of data || []) {
                    contactsById.set(contact.id, contact);
                }
            }

            const eligibleContacts = contactIds
                .map((contactId) => {
                    const contact = contactsById.get(contactId);
                    if (!contact) return null;
                    const hours = normalizeBestContactHours(contact);
                    if (hours.length < 3) return null;
                    return { id: contactId, hours };
                })
                .filter((contact): contact is { id: string; hours: number[] } => contact !== null);

            if (eligibleContacts.length === 0) {
                return NextResponse.json(
                    {
                        error: 'Bad Request',
                        message: 'No selected contacts have 3 best times to contact yet. Re-sync or recalculate best-time data first.'
                    },
                    { status: 400 }
                );
            }

            const dateParts = getTomorrowPhilippinesDateParts();
            const scheduledCampaigns: ScheduledCampaignSummary[] = [];

            for (let messageIndex = 0; messageIndex < 3; messageIndex++) {
                const recipientSchedules = eligibleContacts.map((contact) => ({
                    contactId: contact.id,
                    scheduledAt: getPhilippinesScheduledAtIso(contact.hours[messageIndex], dateParts)
                }));
                const earliestScheduledAt = recipientSchedules
                    .map((recipient) => recipient.scheduledAt)
                    .sort()[0];

                const { data: campaign, error: campaignError } = await supabase
                    .from('campaigns')
                    .insert({
                        page_id: pageId,
                        name: `${typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Bulk best-time message'} ${messageIndex + 1}/3`,
                        message_text: serializeCampaignMessageSequence([scheduledMessages[messageIndex]]),
                        status: 'scheduled',
                        scheduled_at: earliestScheduledAt,
                        scheduled_date: earliestScheduledAt,
                        total_recipients: eligibleContacts.length,
                        sent_count: 0,
                        failed_count: 0,
                        created_by: session.user.id,
                        audience_mode: 'specific',
                        use_best_time: true,
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

                for (const batch of chunkArray(recipientSchedules, 500)) {
                    const { error } = await supabase
                        .from('campaign_recipients')
                        .insert(batch.map((recipient) => ({
                            campaign_id: campaign.id,
                            contact_id: recipient.contactId,
                            status: 'pending',
                            scheduled_at: recipient.scheduledAt
                        })));

                    if (error) {
                        throw error;
                    }
                }

                scheduledCampaigns.push({
                    id: campaign.id,
                    messageNumber: messageIndex + 1,
                    scheduledAt: earliestScheduledAt,
                    scheduledAtPh: formatPhilippinesScheduledAt(earliestScheduledAt),
                    recipients: eligibleContacts.length
                });
            }

            const status = await getBulkScheduleStatus(
                supabase,
                pageId,
                scheduledCampaigns.map((campaign) => campaign.id)
            );

            return NextResponse.json({
                success: true,
                mode: deliveryMode,
                campaigns: scheduledCampaigns,
                recipients: eligibleContacts.length,
                totalMatched,
                skippedContacts: contactIds.length - eligibleContacts.length,
                selectedRange,
                status
            });
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

// GET /api/pages/[pageId]/contacts/tracked-bulk-message - Get tracked best-time bulk status
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
        const campaignIds = (request.nextUrl.searchParams.get('campaignIds') || '')
            .split(',')
            .map((campaignId) => campaignId.trim())
            .filter(Boolean);

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

        const status = await getBulkScheduleStatus(supabase, pageId, campaignIds);
        return NextResponse.json({
            success: true,
            status
        });
    } catch (error) {
        console.error('Error fetching tracked bulk message status:', error);
        return NextResponse.json(
            { error: 'Failed to fetch tracked bulk message status', message: (error as Error).message },
            { status: 500 }
        );
    }
}
