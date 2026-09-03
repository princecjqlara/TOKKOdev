import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import {
    getConversationIdForPsid,
    getConversationMessages,
    getPageConversations,
    getPageConversationsBatch,
    isFacebookReauthRequired
} from '@/lib/facebook';
import type { ConversationMessage } from '@/lib/facebook';
import type { FacebookConversation } from '@/types';
import { chunkArray } from '@/lib/chunking';
import { SUPABASE_IN_FILTER_BATCH_SIZE } from '@/lib/supabase-pagination';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type ExportFormat = 'csv' | 'json';

type PageRecord = {
    fb_page_id: string;
    access_token: string;
    name: string;
};

type ContactExportRecord = {
    id: string;
    psid: string | null;
    name: string | null;
};

type ExportedMessage = {
    pageId: string;
    pageName: string;
    fbPageId: string;
    conversationId: string;
    conversationUpdatedTime: string;
    contactPsid: string;
    contactName: string;
    messageId: string;
    senderId: string;
    senderName: string;
    senderType: 'page' | 'contact' | 'unknown';
    sentBy: string;
    direction: 'incoming' | 'outgoing' | 'unknown';
    messageSource: 'contact' | 'manual' | 'campaign' | 'automation' | 'welcome' | 'facebook_page_untracked' | 'unknown';
    sourceName: string;
    sourceId: string;
    actorUserId: string;
    actorName: string;
    messageKind: string;
    message: string;
    sentAt: string;
    createdTime: string;
};

type OutboundMessageEventRecord = {
    message_id: string;
    source_type: 'manual' | 'campaign' | 'automation' | 'welcome';
    source_id: string | null;
    source_name: string | null;
    actor_user_id: string | null;
    actor_name: string | null;
    message_kind: string | null;
};

const FACEBOOK_EXPORT_CONCURRENCY = 8;
const DEFAULT_EXPORT_CONVERSATION_BATCH_SIZE = 25;
const MAX_EXPORT_CONVERSATION_BATCH_SIZE = 50;
const MAX_SELECTED_CONTACTS_PER_BATCHED_REQUEST = 100;
const MAX_SELECTED_CONTACTS_PER_LEGACY_REQUEST = 10000;

type ExportBatchMetadata = {
    nextCursor?: string | null;
    batchComplete?: boolean;
};

async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    const workers = Array.from(
        { length: Math.min(Math.max(1, concurrency), items.length) },
        async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                results[index] = await mapper(items[index], index);
            }
        }
    );

    await Promise.all(workers);
    return results;
}

function parseFormat(value: string | null): ExportFormat {
    return value === 'json' ? 'json' : 'csv';
}

function parseBoolean(value: unknown): boolean {
    return value === true || value === 'true' || value === '1';
}

function parseBatchSize(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_EXPORT_CONVERSATION_BATCH_SIZE;
    return Math.max(1, Math.min(Math.floor(parsed), MAX_EXPORT_CONVERSATION_BATCH_SIZE));
}

function normalizeContactIds(value: unknown): string[] {
    const values = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(',')
            : [];

    return [...new Set(values
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean))];
}

function csvCell(value: unknown) {
    const raw = value === null || typeof value === 'undefined' ? '' : String(value);
    return `"${raw.replace(/"/g, '""')}"`;
}

function toCsv(rows: ExportedMessage[]) {
    const headers: Array<keyof ExportedMessage> = [
        'pageId',
        'pageName',
        'fbPageId',
        'conversationId',
        'conversationUpdatedTime',
        'contactPsid',
        'contactName',
        'messageId',
        'senderId',
        'senderName',
        'senderType',
        'sentBy',
        'direction',
        'messageSource',
        'sourceName',
        'sourceId',
        'actorUserId',
        'actorName',
        'messageKind',
        'message',
        'sentAt',
        'createdTime'
    ];

    return [
        headers.join(','),
        ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(','))
    ].join('\n');
}

function sanitizeFilenamePart(value: string) {
    return value
        .trim()
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'page';
}

function getContactParticipant(conversation: FacebookConversation, fbPageId: string) {
    return conversation.participants?.data?.find((participant) => participant.id !== fbPageId) || null;
}

function mapMessageToExportRow(
    options: {
        pageId: string;
        page: PageRecord;
        conversation: FacebookConversation;
        contactPsid: string;
        contactName: string;
        message: ConversationMessage;
    }
): ExportedMessage {
    const senderId = options.message.from?.id || '';
    const senderType = senderId === options.page.fb_page_id
        ? 'page'
        : senderId === options.contactPsid
            ? 'contact'
            : 'unknown';
    const senderName = options.message.from?.name || '';
    const createdTime = options.message.created_time || '';

    return {
        pageId: options.pageId,
        pageName: options.page.name,
        fbPageId: options.page.fb_page_id,
        conversationId: options.conversation.id,
        conversationUpdatedTime: options.conversation.updated_time || '',
        contactPsid: options.contactPsid,
        contactName: options.contactName,
        messageId: options.message.id,
        senderId,
        senderName,
        senderType,
        sentBy: senderName,
        direction: senderType === 'contact' ? 'incoming' : senderType === 'page' ? 'outgoing' : 'unknown',
        messageSource: senderType === 'contact'
            ? 'contact'
            : senderType === 'page'
                ? 'facebook_page_untracked'
                : 'unknown',
        sourceName: senderType === 'contact' ? 'Messenger contact' : '',
        sourceId: '',
        actorUserId: '',
        actorName: '',
        messageKind: '',
        message: options.message.message || '',
        sentAt: createdTime,
        createdTime
    };
}

async function addOutboundAttribution(
    supabase: ReturnType<typeof getSupabaseAdmin>,
    pageId: string,
    rows: ExportedMessage[]
): Promise<ExportedMessage[]> {
    const pageMessageIds = [...new Set(
        rows
            .filter((row) => row.senderType === 'page' && row.messageId)
            .map((row) => row.messageId)
    )];
    if (pageMessageIds.length === 0) return rows;

    const events = new Map<string, OutboundMessageEventRecord>();

    try {
        for (const batch of chunkArray(pageMessageIds, SUPABASE_IN_FILTER_BATCH_SIZE)) {
            const { data, error } = await supabase
                .from('outbound_message_events')
                .select('message_id, source_type, source_id, source_name, actor_user_id, actor_name, message_kind')
                .eq('page_id', pageId)
                .in('message_id', batch);

            if (error) {
                // Allow exports while the attribution migration is being rolled out.
                console.warn('[CONVERSATION_EXPORT] Message attribution is unavailable:', error.message);
                return rows;
            }

            for (const event of (data || []) as OutboundMessageEventRecord[]) {
                events.set(event.message_id, event);
            }
        }
    } catch (error) {
        console.warn(
            '[CONVERSATION_EXPORT] Message attribution is unavailable:',
            error instanceof Error ? error.message : error
        );
        return rows;
    }

    return rows.map((row) => {
        const event = events.get(row.messageId);
        if (!event) return row;

        return {
            ...row,
            sentBy: event.actor_name || row.senderName || row.pageName,
            messageSource: event.source_type,
            sourceName: event.source_name || '',
            sourceId: event.source_id || '',
            actorUserId: event.actor_user_id || '',
            actorName: event.actor_name || '',
            messageKind: event.message_kind || ''
        };
    });
}

async function getAuthorizedPage(
    supabase: ReturnType<typeof getSupabaseAdmin>,
    userId: string,
    pageId: string
): Promise<PageRecord | null | 'forbidden'> {
    const { data: userPage } = await supabase
        .from('user_pages')
        .select('page_id')
        .eq('user_id', userId)
        .eq('page_id', pageId)
        .single();

    if (!userPage) {
        return 'forbidden';
    }

    const { data: page } = await supabase
        .from('pages')
        .select('fb_page_id, access_token, name')
        .eq('id', pageId)
        .single();

    return page as PageRecord | null;
}

async function getContactsForExport(
    supabase: ReturnType<typeof getSupabaseAdmin>,
    pageId: string,
    contactIds: string[]
): Promise<ContactExportRecord[]> {
    if (contactIds.length === 0) return [];

    const contacts: ContactExportRecord[] = [];
    for (const batch of chunkArray(contactIds, SUPABASE_IN_FILTER_BATCH_SIZE)) {
        const { data, error } = await supabase
            .from('contacts')
            .select('id, psid, name')
            .eq('page_id', pageId)
            .in('id', batch);

        if (error) {
            throw error;
        }

        contacts.push(...((data || []) as ContactExportRecord[]));
    }

    return contacts;
}

async function buildRowsForAllPageConversations(pageId: string, page: PageRecord) {
    const conversations = await getPageConversations(
        page.fb_page_id,
        page.access_token,
        100,
        true
    );

    const conversationRows = await mapWithConcurrency(
        conversations,
        FACEBOOK_EXPORT_CONCURRENCY,
        async (conversation) => {
            const contact = getContactParticipant(conversation, page.fb_page_id);
            const contactPsid = contact?.id || '';
            const contactName = contact?.name || '';
            const messages = await getConversationMessages(
                conversation.id,
                page.access_token,
                Number.MAX_SAFE_INTEGER,
                { throwOnError: true }
            );

            return messages.map((message) => mapMessageToExportRow({
                pageId,
                page,
                conversation,
                contactPsid,
                contactName,
                message
            }));
        }
    );
    const rows = conversationRows.flat();

    return {
        rows,
        conversationCount: conversations.length,
        selectedContactCount: null as number | null
    };
}

async function buildRowsForPageConversationBatch(
    pageId: string,
    page: PageRecord,
    cursor: string | null,
    batchSize: number
) {
    const batch = await getPageConversationsBatch(
        page.fb_page_id,
        page.access_token,
        { limit: batchSize, after: cursor }
    );
    const conversationRows = await mapWithConcurrency(
        batch.conversations,
        FACEBOOK_EXPORT_CONCURRENCY,
        async (conversation) => {
            const contact = getContactParticipant(conversation, page.fb_page_id);
            const contactPsid = contact?.id || '';
            const contactName = contact?.name || '';
            const messages = await getConversationMessages(
                conversation.id,
                page.access_token,
                Number.MAX_SAFE_INTEGER,
                { throwOnError: true }
            );

            return messages.map((message) => mapMessageToExportRow({
                pageId,
                page,
                conversation,
                contactPsid,
                contactName,
                message
            }));
        }
    );

    return {
        rows: conversationRows.flat(),
        conversationCount: batch.conversations.length,
        selectedContactCount: null as number | null,
        nextCursor: batch.nextCursor,
        batchComplete: !batch.nextCursor
    };
}

async function buildRowsForSelectedContacts(
    pageId: string,
    page: PageRecord,
    contacts: ContactExportRecord[]
) {
    const contactResults = await mapWithConcurrency(
        contacts,
        FACEBOOK_EXPORT_CONCURRENCY,
        async (contact) => {
            if (!contact.psid) return { rows: [] as ExportedMessage[], hasConversation: false };
            const contactPsid = contact.psid;

            const conversationId = await getConversationIdForPsid(
                page.fb_page_id,
                contactPsid,
                page.access_token,
                { throwOnError: true }
            );
            if (!conversationId) return { rows: [] as ExportedMessage[], hasConversation: false };

            const conversation: FacebookConversation = {
                id: conversationId,
                updated_time: '',
                participants: {
                    data: [
                        { id: page.fb_page_id, name: page.name },
                        { id: contactPsid, name: contact.name || '' }
                    ]
                }
            };
            const messages = await getConversationMessages(
                conversationId,
                page.access_token,
                Number.MAX_SAFE_INTEGER,
                { throwOnError: true }
            );

            return {
                hasConversation: true,
                rows: messages.map((message) => mapMessageToExportRow({
                    pageId,
                    page,
                    conversation,
                    contactPsid,
                    contactName: contact.name || '',
                    message
                }))
            };
        }
    );
    const rows = contactResults.flatMap((result) => result.rows);
    const conversationCount = contactResults.filter((result) => result.hasConversation).length;

    return {
        rows,
        conversationCount,
        selectedContactCount: contacts.length
    };
}

async function handleExport(
    request: NextRequest,
    paramsPromise: Promise<{ pageId: string }>
) {
    try {
        const session = await getSessionFromRequest(request);
        const userId = session?.user?.id;

        if (!userId) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const { pageId } = await paramsPromise;
        const url = new URL(request.url);
        const body = request.method === 'POST'
            ? await request.json().catch(() => ({} as Record<string, unknown>))
            : {};
        const format = parseFormat(
            typeof body.format === 'string' ? body.format : url.searchParams.get('format')
        );
        const batched = parseBoolean(
            typeof body.batched !== 'undefined' ? body.batched : url.searchParams.get('batched')
        );
        const cursorValue = typeof body.cursor === 'string' ? body.cursor : url.searchParams.get('cursor');
        const cursor = cursorValue?.trim() || null;
        const batchSize = parseBatchSize(
            typeof body.batchSize !== 'undefined' ? body.batchSize : url.searchParams.get('batchSize')
        );
        const contactIds = normalizeContactIds(
            Array.isArray(body.contactIds) || typeof body.contactIds === 'string'
                ? body.contactIds
                : url.searchParams.get('contactIds')
        );
        const supabase = getSupabaseAdmin();
        const page = await getAuthorizedPage(supabase, userId, pageId);

        if (page === 'forbidden') {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this page' },
                { status: 403 }
            );
        }

        if (!page) {
            return NextResponse.json(
                { error: 'Not Found', message: 'Page not found' },
                { status: 404 }
            );
        }


        if (batched && contactIds.length > MAX_SELECTED_CONTACTS_PER_BATCHED_REQUEST) {
            return NextResponse.json(
                {
                    error: 'Export Batch Too Large',
                    message: `Send at most ${MAX_SELECTED_CONTACTS_PER_BATCHED_REQUEST} selected contacts per export batch.`
                },
                { status: 413 }
            );
        }

        if (!batched && contactIds.length > MAX_SELECTED_CONTACTS_PER_LEGACY_REQUEST) {
            return NextResponse.json(
                {
                    error: 'Export Request Too Large',
                    message: 'This export is too large for one request. Refresh the Contacts page and retry so it can use resumable batches.'
                },
                { status: 413 }
            );
        }

        const exportResult = contactIds.length > 0
            ? await buildRowsForSelectedContacts(
                pageId,
                page,
                await getContactsForExport(supabase, pageId, contactIds)
            )
            : batched
                ? await buildRowsForPageConversationBatch(pageId, page, cursor, batchSize)
                : await buildRowsForAllPageConversations(pageId, page);
        const { conversationCount, selectedContactCount } = exportResult;
        const rows = await addOutboundAttribution(supabase, pageId, exportResult.rows);
        const batchMetadata = exportResult as typeof exportResult & ExportBatchMetadata;

        const exportedAt = new Date().toISOString();
        const scope = contactIds.length > 0 ? 'selected-contact-conversations' : 'conversations';
        const filenameBase = `${sanitizeFilenamePart(page.name)}-${scope}-${exportedAt.slice(0, 10)}`;
        const batchHeaders: Record<string, string> = batched
            ? {
                'X-Export-Batched': 'true',
                'X-Export-Batch-Complete': String(batchMetadata.batchComplete !== false),
                'X-Export-Conversation-Count': String(conversationCount),
                'X-Export-Message-Count': String(rows.length),
                ...(batchMetadata.nextCursor
                    ? { 'X-Export-Next-Cursor': batchMetadata.nextCursor }
                    : {})
            }
            : {};

        if (format === 'json') {
            return new NextResponse(
                JSON.stringify({
                    exportedAt,
                    page: {
                        id: pageId,
                        name: page.name,
                        fbPageId: page.fb_page_id
                    },
                    conversationCount,
                    selectedContactCount,
                    messageCount: rows.length,
                    messages: rows
                }, null, 2),
                {
                    headers: {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Content-Disposition': `attachment; filename="${filenameBase}.json"`,
                        ...batchHeaders
                    }
                }
            );
        }

        return new NextResponse(toCsv(rows), {
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="${filenameBase}.csv"`,
                ...batchHeaders
            }
        });
    } catch (error) {
        console.error('[CONVERSATION_EXPORT] Export failed:', error);
        if (isFacebookReauthRequired(error)) {
            return NextResponse.json(
                {
                    error: 'Page Reconnect Required',
                    message: 'Facebook rejected the stored page token. Reconnect this page to refresh permissions before exporting conversations.',
                    requiresReconnect: true
                },
                { status: 409 }
            );
        }

        return NextResponse.json(
            { error: 'Export Failed', message: (error as Error).message || 'Failed to export conversations' },
            { status: 500 }
        );
    }
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    return handleExport(request, params);
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    return handleExport(request, params);
}
