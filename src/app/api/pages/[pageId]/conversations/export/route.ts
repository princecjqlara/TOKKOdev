import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import {
    getConversationMessages,
    getPageConversations,
    isFacebookReauthRequired
} from '@/lib/facebook';
import type { ConversationMessage } from '@/lib/facebook';
import type { FacebookConversation } from '@/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type ExportFormat = 'csv' | 'json';

type PageRecord = {
    fb_page_id: string;
    access_token: string;
    name: string;
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

function parseFormat(value: string | null): ExportFormat {
    return value === 'json' ? 'json' : 'csv';
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

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
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

        const { pageId } = await params;
        const format = parseFormat(new URL(request.url).searchParams.get('format'));
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

        const conversations = await getPageConversations(
            page.fb_page_id,
            page.access_token,
            100,
            true
        );

        const rows: ExportedMessage[] = [];
        for (const conversation of conversations) {
            const contact = getContactParticipant(conversation, page.fb_page_id);
            const contactPsid = contact?.id || '';
            const contactName = contact?.name || '';
            const messages = await getConversationMessages(
                conversation.id,
                page.access_token,
                Number.MAX_SAFE_INTEGER
            );

            for (const message of messages) {
                rows.push(mapMessageToExportRow({
                    pageId,
                    page,
                    conversation,
                    contactPsid,
                    contactName,
                    message
                }));
            }
        }

        const exportedAt = new Date().toISOString();
        const filenameBase = `${sanitizeFilenamePart(page.name)}-conversations-${exportedAt.slice(0, 10)}`;

        if (format === 'json') {
            return new NextResponse(
                JSON.stringify({
                    exportedAt,
                    page: {
                        id: pageId,
                        name: page.name,
                        fbPageId: page.fb_page_id
                    },
                    conversationCount: conversations.length,
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
