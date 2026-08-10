import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import {
    getConversationIdForPsid,
    getConversationMessages,
    getPageConversations,
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
    message: string;
    createdTime: string;
};

const FACEBOOK_EXPORT_CONCURRENCY = 8;

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

function normalizeContactIds(value: unknown): string[] {
    const values = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(',')
            : [];

    return [...new Set(values
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean))]
        .slice(0, 10000);
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
        'message',
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
        senderName: options.message.from?.name || '',
        senderType:
            senderId === options.page.fb_page_id
                ? 'page'
                : senderId === options.contactPsid
                    ? 'contact'
                    : 'unknown',
        message: options.message.message || '',
        createdTime: options.message.created_time || ''
    };
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
                Number.MAX_SAFE_INTEGER
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
                page.access_token
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
                Number.MAX_SAFE_INTEGER
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

        const exportResult = contactIds.length > 0
            ? await buildRowsForSelectedContacts(
                pageId,
                page,
                await getContactsForExport(supabase, pageId, contactIds)
            )
            : await buildRowsForAllPageConversations(pageId, page);
        const { rows, conversationCount, selectedContactCount } = exportResult;

        const exportedAt = new Date().toISOString();
        const scope = contactIds.length > 0 ? 'selected-contact-conversations' : 'conversations';
        const filenameBase = `${sanitizeFilenamePart(page.name)}-${scope}-${exportedAt.slice(0, 10)}`;

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
                        'Content-Disposition': `attachment; filename="${filenameBase}.json"`
                    }
                }
            );
        }

        return new NextResponse(toCsv(rows), {
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="${filenameBase}.csv"`
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
