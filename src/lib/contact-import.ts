import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from './supabase';
import { databaseRequest } from './database-request';
import { getPageConversationsBatch, isFacebookReauthRequired } from './facebook';
import { normalizeContactName, pickPreferredContactName } from './contact-names';
import { getPhilippinesHour } from './philippines-time';
import { createContactMessagingAutoTagger } from './messaging-auto-tag-sync';
import { AccessError } from './account-security';

export const CONTACT_IMPORT_FOLDERS = ['inbox', 'other', 'page_done', 'spam'] as const;
export type ContactImportFolder = typeof CONTACT_IMPORT_FOLDERS[number];
type Database = ReturnType<typeof getSupabaseAdmin>;
type ImportJob = {
    page_id: string; run_id: string; status: string; folder: ContactImportFolder; cursor: string | null;
    processed_count: number; started_at: string; retry_after: string | null; last_error: string | null;
};
type ClaimedImport = ImportJob & { fb_page_id: string; access_token: string; auto_tag: boolean; messaging_auto_tag_enabled: boolean };
export type ContactImportResult = {
    success: boolean; durable: boolean; partial: boolean; pageId?: string; syncRunId?: string; syncStartedAt?: string;
    cursor?: string | null; folder?: ContactImportFolder; totalSynced?: number; synced: number; failed: number;
    waiting?: boolean; retryAfterMs?: number; idle?: boolean; tagged?: number; tagFailures?: number; message?: string;
};
function one<T>(data: T | T[] | null): T | null { return Array.isArray(data) ? data[0] || null : data; }
function timestamp(value: unknown): string | null {
    const time = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function progress(job: ImportJob, extra: Partial<ContactImportResult> = {}): ContactImportResult {
    return { success: true, durable: true, partial: job.status !== 'completed', pageId: job.page_id,
        syncRunId: job.run_id, syncStartedAt: job.started_at, cursor: job.cursor, folder: job.folder,
        totalSynced: job.processed_count, synced: 0, failed: 0, ...extra };
}
function migrationError(error: { code?: string; message?: string }) {
    if (error.code === 'PGRST202' || error.code === '42P01') {
        throw new AccessError(503, 'Contact import setup is missing. Install migration_durable_contact_import.sql before syncing.');
    }
    throw error;
}

/** A single fast, durable slice. Saving contacts and moving the cursor share one SQL transaction. */
export async function processContactImport(options: {
    pageId?: string; syncRunId?: string; autoTag?: boolean; supabase?: Database;
} = {}): Promise<ContactImportResult> {
    const db = options.supabase || getSupabaseAdmin();
    let requested: ImportJob | null = null;
    if (options.pageId) {
        const result = await databaseRequest(db.rpc('request_contact_import', {
            p_page_id: options.pageId,
            p_run_id: /^[a-f\d-]{36}$/i.test(options.syncRunId || '') ? options.syncRunId : null,
            p_auto_tag: options.autoTag !== false
        }));
        if (result.error) migrationError(result.error);
        requested = one<ImportJob>(result.data);
        if (!requested) throw new Error('Contact import did not return its checkpoint.');
        if (requested.status === 'completed') return progress(requested);
        if (requested.status === 'blocked') throw new AccessError(403, requested.last_error || 'Reconnect this Facebook Page before syncing.');
    }
    const owner = randomUUID();
    const claim = await databaseRequest(db.rpc('claim_contact_import', { p_owner: owner, p_page_id: options.pageId || null }));
    if (claim.error) migrationError(claim.error);
    const job = one<ClaimedImport>(claim.data);
    if (!job) {
        return requested ? progress(requested, { waiting: true, retryAfterMs: 2000,
            message: 'Import is queued or another worker is saving this batch. Progress is retained.' })
            : { success: true, durable: true, partial: false, synced: 0, failed: 0, idle: true };
    }

    try {
        const autoTag = job.auto_tag && job.messaging_auto_tag_enabled !== false;
        const batch = await getPageConversationsBatch(job.fb_page_id, job.access_token, {
            limit: autoTag ? 100 : 500, after: job.cursor, folder: job.folder, includeMessages: autoTag, messageLimit: 20,
            signal: AbortSignal.timeout(12_000)
        });
        if (batch.nextCursor && batch.nextCursor === job.cursor) throw new Error('Facebook returned a repeated contact cursor; checkpoint retained.');
        const contacts = new Map<string, { psid: string; name: string | null; last_interaction_at: string | null;
            last_inbound_at: string | null; best_contact_hour: number | null }>();
        const histories = new Map<string, NonNullable<typeof batch.conversations[number]['messages']>['data']>();
        for (const conversation of batch.conversations) {
            if (!Array.isArray(conversation.participants?.data)) throw new Error('Facebook omitted conversation participants; checkpoint retained.');
            const participants = conversation.participants?.data?.filter(person => person.id && person.id !== job.fb_page_id) || [];
            if (participants.length !== 1) continue;
            const participant = participants[0];
            const messages = conversation.messages?.data || [];
            const inbound = messages.filter(message => message.from?.id === participant.id && timestamp(message.created_time))
                .sort((a,b) => Date.parse(b.created_time) - Date.parse(a.created_time))[0];
            const interaction = timestamp(conversation.updated_time);
            const previous = contacts.get(participant.id);
            const newestInteraction = [interaction, previous?.last_interaction_at].filter((value): value is string => Boolean(value)).sort().pop() || null;
            const newestInbound = [timestamp(inbound?.created_time), previous?.last_inbound_at].filter((value): value is string => Boolean(value)).sort().pop() || null;
            contacts.set(participant.id, { psid: participant.id,
                name: pickPreferredContactName(normalizeContactName(participant.name), ...messages.filter(message => message.from?.id === participant.id).map(message => message.from?.name), previous?.name),
                last_interaction_at: newestInteraction, last_inbound_at: newestInbound,
                best_contact_hour: newestInteraction ? getPhilippinesHour(new Date(newestInteraction)) : null });
            histories.set(participant.id, [...(histories.get(participant.id) || []), ...messages]);
        }
        const nextFolder = batch.nextCursor ? job.folder : CONTACT_IMPORT_FOLDERS[CONTACT_IMPORT_FOLDERS.indexOf(job.folder) + 1] || null;
        const saved = await databaseRequest(db.rpc('finish_contact_import_slice', {
            p_page_id: job.page_id, p_owner: owner, p_contacts: [...contacts.values()],
            p_next_cursor: batch.nextCursor, p_next_folder: nextFolder
        }));
        if (saved.error) throw saved.error;
        const checkpoint = one<ImportJob>(saved.data);
        if (!checkpoint) throw new Error('The contact import checkpoint was not confirmed.');

        // Optional tag work follows the saved import. It never delays the next
        // Facebook page behind per-contact profile or message-history requests.
        let tagged = 0, tagFailures = 0;
        if (autoTag) {
            const tagger = createContactMessagingAutoTagger(db, { id: job.page_id, fb_page_id: job.fb_page_id });
            const pending = [...histories.entries()];
            const tagStartedAt = Date.now();
            for (let i = 0; i < pending.length; i += 10) {
                if (Date.now() - tagStartedAt > 5000) { tagFailures += pending.length - i; break; }
                const results = await Promise.allSettled(pending.slice(i,i + 10).map(async ([psid,messages]) => tagger(psid, messages)));
                tagged += results.filter(result => result.status === 'fulfilled' && result.value).length;
                tagFailures += results.filter(result => result.status === 'rejected').length;
            }
        }
        return progress(checkpoint, { synced: contacts.size, tagged, tagFailures,
            message: checkpoint.status === 'completed' ? 'All available Messenger folders have been imported.' : 'Saved contacts; continuing the remaining folders.' });
    } catch (error) {
        const reconnect = isFacebookReauthRequired(error);
        const failure = error && typeof error === 'object' ? error as { message?: string; code?: number | string; status?: number } : {};
        const rateLimited = failure.status === 429 || [4,17,32,341,613].includes(Number(failure.code));
        const message = reconnect ? 'Facebook Page access expired or was revoked. Reconnect this Page to continue importing.'
            : rateLimited ? 'Facebook requested a cooldown. Import progress is saved for retry.'
            : 'Contact import failed; the saved checkpoint will be retried.';
        await databaseRequest(db.from('page_contact_imports').update({ status: reconnect ? 'blocked' : 'queued',
            retry_after: reconnect ? null : new Date(Date.now() + (rateLimited ? 60_000 : 5000)).toISOString(),
            last_error: message, lease_owner: null, lease_until: null }).eq('page_id',job.page_id).eq('lease_owner',owner))
            .catch(() => {});
        await databaseRequest(db.rpc('release_page_sync_lease', { p_page_id: job.page_id, p_owner: owner })).catch(() => {});
        throw new AccessError(reconnect ? 403 : 503, message);
    }
}
