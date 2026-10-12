import { getPageConversationsBatch, isFacebookReauthRequired } from '@/lib/facebook';
import { classifyMessengerSystemMessage } from '@/lib/messaging-auto-tag';
import { getSupabaseAdmin } from '@/lib/supabase';
import { randomUUID } from 'node:crypto';

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
        if (url.hostname !== 'graph.facebook.com' || seen.has(next)) throw new Error('Unexpected Messenger pagination URL');
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
        messages.push(...rows.filter(message => new Date(message.created_time).getTime() >= new Date(since).getTime()));
        if (rows.some(message => new Date(message.created_time).getTime() < new Date(since).getTime())) return messages;
        next = body.paging?.next || null;
    }
    if (next) throw new Error('Messenger history exceeded the safe per-conversation limit');
    return messages;
}

export async function processOneMessagingAutoTagPage(options: { pageId?: string; maxProcessingTimeMs?: number } = {}) {
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
        const { data: tags, error: tagError } = await db.from('tags').select('id,name,is_default')
            .eq('owner_type', 'page').eq('owner_id', current.id);
        if (tagError) throw tagError;
        const defaultTags = new Map((tags || []).filter(tag => tag.is_default)
            .map(tag => [tag.name.toLowerCase().replace(/[^a-z]/g, ''), tag.id]));
        const outcomeTags = new Map((tags || []).map(tag => [tag.name.toLowerCase().replace(/[^a-z]/g, ''), tag.id]));
        const paidTagId = defaultTags.get('paidavailedservice') || defaultTags.get('paidavailedservices');
        const unqualifiedTagId = outcomeTags.get('notqualified') || outcomeTags.get('unqualified');
        if (!paidTagId || !unqualifiedTagId) throw new Error('Required Page tags are missing');

        const batch = await getPageConversationsBatch(current.fb_page_id, current.access_token, {
            limit: 10,
            after: current.messaging_auto_tag_cursor,
            sinceTimestamp: current.messaging_auto_tag_checked_at,
            signal: controller.signal
        });
        let tagged = 0;
        // Bound Meta concurrency while avoiding ten sequential history waits.
        for (let offset = 0; offset < batch.conversations.length; offset += 3) {
            const chunkResults = await Promise.allSettled(batch.conversations.slice(offset, offset + 3).map(async conversation => {
                const participant = conversation.participants?.data?.find(p => p.id !== current.fb_page_id);
                if (!participant) return;
                const messages = await getMessagesSince(conversation.id, current.access_token, current.messaging_auto_tag_checked_at, controller.signal);
                const signals = messages
                    .filter(message => message.from?.id === current.fb_page_id)
                    .map(message => classifyMessengerSystemMessage(message.message || ''))
                    .filter(signal => signal !== null);
                const targetTagIds = new Set<string>();
                if (signals.some(signal => signal === 'unqualified')) targetTagIds.add(unqualifiedTagId);
                if (signals.some(signal => signal !== 'unqualified')) targetTagIds.add(paidTagId);
                if (targetTagIds.size === 0) return;

                let { data: contact, error: contactError } = await db.from('contacts').select('id')
                    .eq('page_id', current.id).eq('psid', participant.id).maybeSingle();
                if (contactError) throw contactError;
                if (!contact) {
                    const inserted = await db.from('contacts').insert({
                        page_id: current.id,
                        psid: participant.id,
                        name: participant.name?.trim() || null
                    }).select('id').single();
                    if (inserted.error) {
                        // Another worker may have created the contact first.
                        const found = await db.from('contacts').select('id')
                            .eq('page_id', current.id).eq('psid', participant.id).single();
                        if (found.error) throw inserted.error;
                        contact = found.data;
                    } else {
                        contact = inserted.data;
                    }
                }
                const { error: assignError } = await db.from('contact_tags').upsert(
                    Array.from(targetTagIds, tagId => ({ contact_id: contact.id, tag_id: tagId })),
                    { onConflict: 'contact_id,tag_id', ignoreDuplicates: true }
                );
                if (assignError) throw assignError;
                tagged++;
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
