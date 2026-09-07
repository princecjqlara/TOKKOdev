import { getSupabaseAdmin } from '@/lib/supabase';
import {
    getConversationIdForPsid,
    getConversationMessages,
    getPageConversationsBatch,
    isFacebookReauthRequired
} from '@/lib/facebook';
import type { ConversationMessage } from '@/lib/facebook';
import type { FacebookConversation } from '@/types';
import { chunkArray } from '@/lib/chunking';
import { SUPABASE_IN_FILTER_BATCH_SIZE } from '@/lib/supabase-pagination';

export const CONVERSATION_EXPORT_BUCKET = 'conversation-exports';
export const CONVERSATION_EXPORT_BATCH_SIZE = 25;
const FACEBOOK_EXPORT_CONCURRENCY = 8;
const MAX_EXPORT_CHUNK_BYTES = 100 * 1024 * 1024;
const MAX_ATTEMPTS = 3;

type PageRecord = {
    fb_page_id: string;
    access_token: string;
    name: string;
};

type ContactRecord = {
    id: string;
    psid: string | null;
    name: string | null;
};

type ExportJob = {
    id: string;
    page_id: string;
    created_by: string;
    scope: 'all' | 'selected';
    contact_ids: unknown;
    next_contact_index: number;
    next_cursor: string | null;
    total_items: number | null;
    processed_items: number;
    conversation_count: number;
    message_count: number;
    chunk_count: number;
    filename: string;
    storage_prefix: string;
    attempt_count: number;
    claim_token: string;
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

type OutboundEvent = {
    message_id: string;
    source_type: 'manual' | 'campaign' | 'automation' | 'welcome';
    source_id: string | null;
    source_name: string | null;
    actor_user_id: string | null;
    actor_name: string | null;
    message_kind: string | null;
};

function normalizeContactIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
}

async function mapWithConcurrency<T, R>(items: T[], mapper: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const workers = Array.from(
        { length: Math.min(FACEBOOK_EXPORT_CONCURRENCY, items.length) },
        async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                results[index] = await mapper(items[index]);
            }
        }
    );
    await Promise.all(workers);
    return results;
}

function getContactParticipant(conversation: FacebookConversation, fbPageId: string) {
    return conversation.participants?.data?.find((participant) => participant.id !== fbPageId) || null;
}

function mapMessage(
    pageId: string,
    page: PageRecord,
    conversation: FacebookConversation,
    contactPsid: string,
    contactName: string,
    message: ConversationMessage
): ExportedMessage {
    const senderId = message.from?.id || '';
    const senderType = senderId === page.fb_page_id
        ? 'page'
        : senderId === contactPsid ? 'contact' : 'unknown';
    const senderName = message.from?.name || '';
    const createdTime = message.created_time || '';

    return {
        pageId,
        pageName: page.name,
        fbPageId: page.fb_page_id,
        conversationId: conversation.id,
        conversationUpdatedTime: conversation.updated_time || '',
        contactPsid,
        contactName,
        messageId: message.id,
        senderId,
        senderName,
        senderType,
        sentBy: senderName,
        direction: senderType === 'contact' ? 'incoming' : senderType === 'page' ? 'outgoing' : 'unknown',
        messageSource: senderType === 'contact'
            ? 'contact'
            : senderType === 'page' ? 'facebook_page_untracked' : 'unknown',
        sourceName: senderType === 'contact' ? 'Messenger contact' : '',
        sourceId: '',
        actorUserId: '',
        actorName: '',
        messageKind: '',
        message: message.message || '',
        sentAt: createdTime,
        createdTime
    };
}

async function addOutboundAttribution(pageId: string, rows: ExportedMessage[]) {
    const messageIds = [...new Set(rows
        .filter((row) => row.senderType === 'page' && row.messageId)
        .map((row) => row.messageId))];
    if (messageIds.length === 0) return rows;

    const supabase = getSupabaseAdmin();
    const events = new Map<string, OutboundEvent>();
    try {
        for (const ids of chunkArray(messageIds, SUPABASE_IN_FILTER_BATCH_SIZE)) {
            const { data, error } = await supabase
                .from('outbound_message_events')
                .select('message_id, source_type, source_id, source_name, actor_user_id, actor_name, message_kind')
                .eq('page_id', pageId)
                .in('message_id', ids);
            if (error) throw error;
            for (const event of (data || []) as OutboundEvent[]) events.set(event.message_id, event);
        }
    } catch (error) {
        console.warn('[EXPORT_WORKER] Message attribution is unavailable:', error);
        return rows;
    }

    return rows.map((row) => {
        const event = events.get(row.messageId);
        return event ? {
            ...row,
            sentBy: event.actor_name || row.senderName || row.pageName,
            messageSource: event.source_type,
            sourceName: event.source_name || '',
            sourceId: event.source_id || '',
            actorUserId: event.actor_user_id || '',
            actorName: event.actor_name || '',
            messageKind: event.message_kind || ''
        } : row;
    });
}

function csvCell(value: unknown) {
    const raw = value === null || typeof value === 'undefined' ? '' : String(value);
    return `"${raw.replace(/"/g, '""')}"`;
}

function toCsv(rows: ExportedMessage[]) {
    const headers: Array<keyof ExportedMessage> = [
        'pageId', 'pageName', 'fbPageId', 'conversationId', 'conversationUpdatedTime',
        'contactPsid', 'contactName', 'messageId', 'senderId', 'senderName', 'senderType',
        'sentBy', 'direction', 'messageSource', 'sourceName', 'sourceId', 'actorUserId',
        'actorName', 'messageKind', 'message', 'sentAt', 'createdTime'
    ];
    return [
        headers.join(','),
        ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(','))
    ].join('\n');
}

async function ensureExportBucket() {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase.storage.getBucket(CONVERSATION_EXPORT_BUCKET);
    if (data) return;
    const { error } = await supabase.storage.createBucket(CONVERSATION_EXPORT_BUCKET, {
        public: false,
        fileSizeLimit: MAX_EXPORT_CHUNK_BYTES,
        allowedMimeTypes: ['text/csv', 'text/plain']
    });
    if (error) {
        const retry = await supabase.storage.getBucket(CONVERSATION_EXPORT_BUCKET);
        if (!retry.data) throw error;
    }
}

async function loadPage(pageId: string): Promise<PageRecord> {
    const { data, error } = await getSupabaseAdmin()
        .from('pages')
        .select('fb_page_id, access_token, name')
        .eq('id', pageId)
        .single();
    if (error || !data) throw error || new Error('The Facebook Page is no longer available.');
    return data as PageRecord;
}

async function loadContacts(pageId: string, ids: string[]): Promise<ContactRecord[]> {
    if (ids.length === 0) return [];
    const { data, error } = await getSupabaseAdmin()
        .from('contacts')
        .select('id, psid, name')
        .eq('page_id', pageId)
        .in('id', ids);
    if (error) throw error;
    const contactsById = new Map(((data || []) as ContactRecord[]).map((contact) => [contact.id, contact]));
    return ids.flatMap((id) => {
        const contact = contactsById.get(id);
        return contact ? [contact] : [];
    });
}

async function exportSelectedBatch(pageId: string, page: PageRecord, contacts: ContactRecord[]) {
    const results = await mapWithConcurrency(contacts, async (contact) => {
        if (!contact.psid) return { hasConversation: false, rows: [] as ExportedMessage[] };
        const conversationId = await getConversationIdForPsid(
            page.fb_page_id,
            contact.psid,
            page.access_token,
            { throwOnError: true }
        );
        if (!conversationId) return { hasConversation: false, rows: [] as ExportedMessage[] };
        const conversation: FacebookConversation = {
            id: conversationId,
            updated_time: '',
            participants: { data: [
                { id: page.fb_page_id, name: page.name },
                { id: contact.psid, name: contact.name || '' }
            ] }
        };
        const messages = await getConversationMessages(
            conversationId,
            page.access_token,
            Number.MAX_SAFE_INTEGER,
            { throwOnError: true }
        );
        return {
            hasConversation: true,
            rows: messages.map((message) => mapMessage(
                pageId, page, conversation, contact.psid || '', contact.name || '', message
            ))
        };
    });
    return {
        rows: results.flatMap((result) => result.rows),
        conversations: results.filter((result) => result.hasConversation).length
    };
}

async function exportAllBatch(pageId: string, page: PageRecord, cursor: string | null) {
    const batch = await getPageConversationsBatch(page.fb_page_id, page.access_token, {
        limit: CONVERSATION_EXPORT_BATCH_SIZE,
        after: cursor
    });
    const rowGroups = await mapWithConcurrency(batch.conversations, async (conversation) => {
        const contact = getContactParticipant(conversation, page.fb_page_id);
        const messages = await getConversationMessages(
            conversation.id,
            page.access_token,
            Number.MAX_SAFE_INTEGER,
            { throwOnError: true }
        );
        return messages.map((message) => mapMessage(
            pageId, page, conversation, contact?.id || '', contact?.name || '', message
        ));
    });
    return {
        rows: rowGroups.flat(),
        conversations: batch.conversations.length,
        nextCursor: batch.nextCursor || null
    };
}

async function markJobError(job: ExportJob, error: unknown) {
    const supabase = getSupabaseAdmin();
    const attemptCount = Number(job.attempt_count || 0) + 1;
    const fatal = isFacebookReauthRequired(error) || attemptCount >= MAX_ATTEMPTS;
    const message = error instanceof Error ? error.message : String(error);
    const { error: updateError } = await supabase
        .from('conversation_export_jobs')
        .update({
            status: fatal ? 'failed' : 'queued',
            attempt_count: attemptCount,
            error_message: message,
            next_attempt_at: fatal ? null : new Date(Date.now() + attemptCount * 60_000).toISOString(),
            claim_token: null,
            claimed_at: null,
            completed_at: fatal ? new Date().toISOString() : null
        })
        .eq('id', job.id)
        .eq('claim_token', job.claim_token);
    if (updateError) console.error('[EXPORT_WORKER] Could not record job failure:', updateError);
}

export async function processOneConversationExportBatch(jobId?: string) {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.rpc('claim_conversation_export_job', {
        p_job_id: jobId || null
    });
    if (error) throw error;
    const job = (Array.isArray(data) ? data[0] : data) as ExportJob | undefined;
    if (!job) return null;

    try {
        await ensureExportBucket();
        const page = await loadPage(job.page_id);
        const contactIds = normalizeContactIds(job.contact_ids);
        let rows: ExportedMessage[];
        let conversations: number;
        let processedItems: number;
        let nextCursor: string | null = null;
        let complete: boolean;
        let nextContactIndex = job.next_contact_index;

        if (job.scope === 'selected') {
            const ids = contactIds.slice(job.next_contact_index, job.next_contact_index + CONVERSATION_EXPORT_BATCH_SIZE);
            const result = await exportSelectedBatch(job.page_id, page, await loadContacts(job.page_id, ids));
            rows = result.rows;
            conversations = result.conversations;
            processedItems = ids.length;
            nextContactIndex += ids.length;
            complete = nextContactIndex >= contactIds.length;
        } else {
            const result = await exportAllBatch(job.page_id, page, job.next_cursor);
            if (result.nextCursor && result.nextCursor === job.next_cursor) {
                throw new Error('Facebook returned a repeated export cursor. Retry the export after reconnecting the Page.');
            }
            rows = result.rows;
            conversations = result.conversations;
            processedItems = result.conversations;
            nextCursor = result.nextCursor;
            complete = !nextCursor;
        }

        rows = await addOutboundAttribution(job.page_id, rows);
        const rawCsv = toCsv(rows);
        const newlineIndex = rawCsv.indexOf('\n');
        const chunkBody = job.chunk_count === 0
            ? rawCsv
            : newlineIndex >= 0 && newlineIndex < rawCsv.length - 1
                ? `\n${rawCsv.slice(newlineIndex + 1)}`
                : '';
        const storagePath = `${job.storage_prefix}/chunk-${String(job.chunk_count).padStart(6, '0')}.csv`;

        if (chunkBody) {
            const { error: uploadError } = await supabase.storage
                .from(CONVERSATION_EXPORT_BUCKET)
                .upload(storagePath, chunkBody, {
                    contentType: 'text/csv',
                    cacheControl: '3600',
                    // Replacing the same deterministic chunk makes a retry safe
                    // if storage succeeded but the database checkpoint did not.
                    upsert: true
                });
            if (uploadError) throw uploadError;
        }

        const now = new Date().toISOString();
        const nextProcessed = Number(job.processed_items || 0) + processedItems;
        const nextChunkCount = Number(job.chunk_count || 0) + (chunkBody ? 1 : 0);
        const update = {
            status: complete ? 'completed' : 'queued',
            next_contact_index: nextContactIndex,
            next_cursor: nextCursor,
            processed_items: nextProcessed,
            total_items: complete ? Math.max(job.total_items || 0, nextProcessed) : job.total_items,
            conversation_count: Number(job.conversation_count || 0) + conversations,
            message_count: Number(job.message_count || 0) + rows.length,
            chunk_count: nextChunkCount,
            attempt_count: 0,
            error_message: null,
            next_attempt_at: null,
            claim_token: null,
            claimed_at: null,
            completed_at: complete ? now : null
        };
        const { error: updateError } = await supabase
            .from('conversation_export_jobs')
            .update(update)
            .eq('id', job.id)
            .eq('claim_token', job.claim_token);
        if (updateError) throw updateError;

        return { jobId: job.id, complete, processedItems, conversations, messages: rows.length };
    } catch (batchError) {
        await markJobError(job, batchError);
        return {
            jobId: job.id,
            complete: false,
            error: batchError instanceof Error ? batchError.message : String(batchError)
        };
    }
}

export async function processConversationExportQueue(options?: {
    jobId?: string;
    maxBatches?: number;
    maxDurationMs?: number;
}) {
    const startedAt = Date.now();
    const results: Awaited<ReturnType<typeof processOneConversationExportBatch>>[] = [];
    const maxBatches = Math.max(1, options?.maxBatches || 6);
    const maxDurationMs = Math.max(5_000, options?.maxDurationMs || 45_000);

    for (let index = 0; index < maxBatches && Date.now() - startedAt < maxDurationMs; index++) {
        const result = await processOneConversationExportBatch(options?.jobId);
        if (!result) break;
        results.push(result);
        if ('error' in result || result.complete) break;
    }
    return results;
}
