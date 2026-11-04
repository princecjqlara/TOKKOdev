import { getPageConversationsBatch, isFacebookReauthRequired } from '@/lib/facebook';
import { createContactMessagingAutoTagger, loadMessagingAutoTagIds } from '@/lib/messaging-auto-tag-sync';
import { getSupabaseAdmin } from '@/lib/supabase';
import { randomUUID } from 'node:crypto';
import { MESSAGING_AUTO_TAG_WINDOW_MS } from './messaging-auto-tag';

type Page = {
    id: string;
    fb_page_id: string;
    access_token: string;
    messaging_auto_tag_checked_at: string;
    messaging_auto_tag_cursor: string | null;
    messaging_auto_tag_scan_started_at: string | null;
};

type Message = { id: string; message?: string; from?: { id?: string }; created_time: string };

async function getMessagesSince(conversationId: string, token: string, since: string, signal: AbortSignal): Promise<Message[]> {
    let next: string | null = `https://graph.facebook.com/v21.0/${encodeURIComponent(conversationId)}/messages?fields=id,message,from,created_time&limit=100`;
    const messages: Message[] = [];
    const seen = new Set<string>();

    for (let page = 0; next && page < 10; page++) {
        const url: URL = new URL(next);
        if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com' || url.username || url.password || seen.has(next)) throw new Error('Unexpected Messenger pagination URL');
        seen.add(next);
        url.searchParams.delete('access_token');
        const response: Response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
            signal, cache: 'no-store'
        });
        const body: { data?: Message[]; paging?: { next?: string }; error?: { message?: string } } = await response.json();
        if (!response.ok || body.error) throw new Error(body.error?.message || `Messenger history HTTP ${response.status}`);
        if (!Array.isArray(body.data)) throw new Error('Messenger history returned incomplete data');
        const rows = body.data;
        if (rows.some(message => !message.id || !Number.isFinite(Date.parse(message.created_time)))) {
            throw new Error('Messenger history returned missing message identifiers or timestamps');
        }
        messages.push(...rows.filter(message => new Date(message.created_time).getTime() >= new Date(since).getTime()));
        if (rows.some(message => new Date(message.created_time).getTime() < new Date(since).getTime())) return messages;
        next = body.paging?.next || null;
    }
    if (next) throw new Error('Messenger history exceeded the safe per-conversation limit');
    return messages;
}

export async function processOneMessagingAutoTagPage(options: {
    pageId?: string; maxProcessingTimeMs?: number; conversationLimit?: number;
} = {}) {
    const db = getSupabaseAdmin();
    const owner = randomUUID();
    const { data: claimed, error: pageError } = await db.rpc('claim_messaging_auto_tag_page', {
        p_owner: owner, p_page_id: options.pageId || null
    });
    if (pageError) throw pageError;
    const page = Array.isArray(claimed) ? claimed[0] : claimed;
    if (!page) return { pages: 0, conversations: 0, tagged: 0 };
    const current = page as Page;
    const runStartedAt = new Date().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, Math.min(20000, options.maxProcessingTimeMs || 18000)));

    try {
        const ids = await loadMessagingAutoTagIds(db, current.id);
        const applyMessengerTags = createContactMessagingAutoTagger(db, current, ids);
        const windowStart = new Date(Date.parse(runStartedAt) - MESSAGING_AUTO_TAG_WINDOW_MS).toISOString();
        const since = new Date(Math.max(Date.parse(windowStart), Date.parse(current.messaging_auto_tag_checked_at) || 0)).toISOString();

        const batch = await getPageConversationsBatch(current.fb_page_id, current.access_token, {
            limit: Math.max(1, Math.min(10, Math.floor(options.conversationLimit || 10))),
            after: current.messaging_auto_tag_cursor,
            sinceTimestamp: since,
            signal: controller.signal
        });
        const psids = [...new Set(batch.conversations.flatMap(conversation => {
            const participants = conversation.participants?.data?.filter(p => p.id !== current.fb_page_id) || [];
            return participants.length === 1 && participants[0].id ? [participants[0].id] : [];
        }))];
        const eligible = new Set<string>();
        if (psids.length) {
            const { data: contacts, error } = await db.from('contacts').select('psid')
                .eq('page_id', current.id).in('psid', psids)
                .gte('last_inbound_at', windowStart).lte('last_inbound_at', runStartedAt);
            if (error) throw error;
            for (const contact of contacts || []) eligible.add(contact.psid);
        }
        let tagged = 0;
        // Bound Meta concurrency while avoiding ten sequential history waits.
        for (let offset = 0; offset < batch.conversations.length; offset += 3) {
            const chunkResults = await Promise.allSettled(batch.conversations.slice(offset, offset + 3).map(async conversation => {
                const participants = conversation.participants?.data?.filter(p => p.id !== current.fb_page_id) || [];
                if (participants.length !== 1) return;
                const participant = participants[0];
                if (!eligible.has(participant.id)) return;
                const messages = await getMessagesSince(conversation.id, current.access_token, since, controller.signal);
                if (await applyMessengerTags(participant.id, messages)) tagged++;
            }));
            const failure = chunkResults.find(result => result.status === 'rejected');
            if (failure?.status === 'rejected') throw failure.reason;
        }

        const { error: checkpointError } = await db.from('pages').update({
            // A scan spanning several cron invocations must finish at its original
            // start time, otherwise updates to early threads during the scan vanish.
            messaging_auto_tag_checked_at: batch.nextCursor ? current.messaging_auto_tag_checked_at
                : current.messaging_auto_tag_scan_started_at || runStartedAt,
            messaging_auto_tag_cursor: batch.nextCursor,
            messaging_auto_tag_scan_started_at: batch.nextCursor ? current.messaging_auto_tag_scan_started_at || runStartedAt : null,
            messaging_auto_tag_attempted_at: runStartedAt,
            messaging_auto_tag_last_error: null,
            messaging_auto_tag_owner: null, messaging_auto_tag_lease_until: null
        }).eq('id', current.id).eq('messaging_auto_tag_owner', owner);
        if (checkpointError) throw checkpointError;
        return { pages: 1, pageId: current.id, conversations: batch.conversations.length, tagged, more: Boolean(batch.nextCursor) };
    } catch (error) {
        await db.from('pages').update({
            messaging_auto_tag_attempted_at: runStartedAt,
            messaging_auto_tag_last_error: controller.signal.aborted ? 'Auto-tag scan timed out; checkpoint kept for retry'
                : isFacebookReauthRequired(error) ? 'Facebook Page access expired or was revoked. Reconnect this Page to resume lead tagging.'
                : error instanceof Error ? error.message.slice(0, 500) : 'Unknown error',
            messaging_auto_tag_owner: null, messaging_auto_tag_lease_until: null
        }).eq('id', current.id).eq('messaging_auto_tag_owner', owner);
        throw error;
    } finally {
        clearTimeout(timeout); controller.abort();
    }
}
