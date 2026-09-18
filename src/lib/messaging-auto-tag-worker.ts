import { getPageConversationsBatch } from '@/lib/facebook';
import { classifyMessengerSystemMessage } from '@/lib/messaging-auto-tag';
import { getSupabaseAdmin } from '@/lib/supabase';

type Page = {
    id: string;
    fb_page_id: string;
    access_token: string;
    messaging_auto_tag_checked_at: string;
    messaging_auto_tag_cursor: string | null;
};

type Message = { id: string; message?: string; from?: { id?: string }; created_time: string };

async function getMessagesSince(conversationId: string, token: string, since: string): Promise<Message[]> {
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
            signal: AbortSignal.timeout(15_000)
        });
        const body: { data?: Message[]; paging?: { next?: string }; error?: { message?: string } } = await response.json();
        if (!response.ok || body.error) throw new Error(body.error?.message || `Messenger history HTTP ${response.status}`);
        const rows = body.data || [];
        messages.push(...rows.filter(message => new Date(message.created_time).getTime() >= new Date(since).getTime()));
        if (rows.some(message => new Date(message.created_time).getTime() < new Date(since).getTime())) return messages;
        next = body.paging?.next || null;
    }
    if (next) throw new Error('Messenger history exceeded the safe per-conversation limit');
    return messages;
}

export async function processOneMessagingAutoTagPage() {
    const db = getSupabaseAdmin();
    const { data: page, error: pageError } = await db.from('pages')
        .select('id,fb_page_id,access_token,messaging_auto_tag_checked_at,messaging_auto_tag_cursor')
        .eq('messaging_auto_tag_enabled', true)
        .order('messaging_auto_tag_attempted_at', { ascending: true })
        .limit(1).maybeSingle();
    if (pageError) throw pageError;
    if (!page) return { pages: 0, conversations: 0, tagged: 0 };
    const current = page as Page;
    const runStartedAt = new Date().toISOString();

    try {
        const { data: tag, error: tagError } = await db.from('tags').select('id')
            .eq('owner_type', 'page').eq('owner_id', current.id).eq('is_default', true).single();
        if (tagError || !tag) throw tagError || new Error('Combined page tag is missing');

        const batch = await getPageConversationsBatch(current.fb_page_id, current.access_token, {
            limit: 10,
            after: current.messaging_auto_tag_cursor,
            sinceTimestamp: current.messaging_auto_tag_checked_at
        });
        let tagged = 0;
        for (const conversation of batch.conversations) {
            const participant = conversation.participants?.data?.find(p => p.id !== current.fb_page_id);
            if (!participant) continue;
            const messages = await getMessagesSince(conversation.id, current.access_token, current.messaging_auto_tag_checked_at);
            const qualifies = messages.some(message =>
                message.from?.id === current.fb_page_id && classifyMessengerSystemMessage(message.message || '') !== null
            );
            if (!qualifies) continue;

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
            const { error: assignError } = await db.from('contact_tags').upsert({
                contact_id: contact.id,
                tag_id: tag.id
            }, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true });
            if (assignError) throw assignError;
            tagged++;
        }

        const { error: checkpointError } = await db.from('pages').update({
            messaging_auto_tag_checked_at: batch.nextCursor ? current.messaging_auto_tag_checked_at : runStartedAt,
            messaging_auto_tag_cursor: batch.nextCursor,
            messaging_auto_tag_attempted_at: runStartedAt,
            messaging_auto_tag_last_error: null
        }).eq('id', current.id);
        if (checkpointError) throw checkpointError;
        return { pages: 1, conversations: batch.conversations.length, tagged, more: Boolean(batch.nextCursor) };
    } catch (error) {
        await db.from('pages').update({
            messaging_auto_tag_attempted_at: runStartedAt,
            messaging_auto_tag_last_error: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error'
        }).eq('id', current.id);
        throw error;
    }
}
