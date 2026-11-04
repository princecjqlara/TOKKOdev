import type { getSupabaseAdmin } from './supabase';
import { classifyMessengerSystemMessage, isWithinMessagingAutoTagWindow, MESSENGER_STAGE_TAG_NAMES,
    type MessengerLeadStage, type MessengerSystemSignal } from './messaging-auto-tag';

type Database = ReturnType<typeof getSupabaseAdmin>;
export type MessengerTagMessage = { message?: string; from?: { id?: string } };
export type MessagingAutoTagIds = Record<MessengerLeadStage, string>;
type PageTag = { id: string; name: string; is_default: boolean };

function findTagIds(tags: PageTag[]) {
    const defaults = new Map(tags.filter(tag => tag.is_default).map(tag => [tag.name, tag.id]));
    return Object.fromEntries(Object.entries(MESSENGER_STAGE_TAG_NAMES)
        .map(([stage, name]) => [stage, defaults.get(name)])) as Partial<MessagingAutoTagIds>;
}

function complete(ids: Partial<MessagingAutoTagIds>): ids is MessagingAutoTagIds {
    return Object.keys(MESSENGER_STAGE_TAG_NAMES).every(stage => Boolean(ids[stage as MessengerLeadStage]));
}

export async function loadMessagingAutoTagIds(db: Database, pageId: string): Promise<MessagingAutoTagIds> {
    const { data: tags, error } = await db.from('tags').select('id,name,is_default')
        .eq('owner_type', 'page').eq('owner_id', pageId);
    if (error) throw error;
    let ids = findTagIds(tags || []);
    if (!complete(ids)) {
        const restored = await db.rpc('ensure_page_default_tags', { p_page_id: pageId });
        if (restored.error) throw new Error(`Could not restore required Page tags: ${restored.error.message || restored.error.code}`);
        ids = findTagIds([...(tags || []), ...(Array.isArray(restored.data) ? restored.data : [])]);
    }
    if (!complete(ids)) throw new Error('Required Page tags are missing');
    return ids;
}

/** Reuse the same observed Messenger events for imports, echoes, and the background scan. */
export function createContactMessagingAutoTagger(db: Database, page: {
    id: string; fb_page_id: string; messaging_auto_tag_enabled?: boolean;
}, initialIds?: MessagingAutoTagIds) {
    let idsPromise: Promise<MessagingAutoTagIds> | undefined = initialIds ? Promise.resolve(initialIds) : undefined;

    return async (psid: string, messages: MessengerTagMessage[]): Promise<boolean> => {
        if (page.messaging_auto_tag_enabled === false || !psid || psid === page.fb_page_id) return false;
        const signals = new Set<MessengerSystemSignal>();
        for (const message of messages) {
            if (message.from?.id !== page.fb_page_id) continue;
            const signal = classifyMessengerSystemMessage(message.message || '');
            if (signal) signals.add(signal);
        }
        if (!signals.size) return false;
        // Contacts are shared by Page. Only a real recent inbound message makes
        // a contact eligible; a stage echo must never open or extend that window.
        const { data: contact, error } = await db.from('contacts').select('id,last_inbound_at')
            .eq('page_id', page.id).eq('psid', psid).maybeSingle();
        if (error) throw error;
        if (!contact || !isWithinMessagingAutoTagWindow(contact.last_inbound_at)) return false;
        if (!idsPromise) {
            idsPromise = loadMessagingAutoTagIds(db, page.id).catch(error => {
                idsPromise = undefined;
                throw error;
            });
        }
        const ids = await idsPromise;
        const targetIds = new Set<string>();
        for (const signal of signals) targetIds.add(ids[signal === 'order_created' ? 'converted' : signal]);
        if (!contact?.id) throw new Error('Could not resolve contact for Messenger tags');
        const assigned = await db.from('contact_tags').upsert(
            [...targetIds].map(tagId => ({ contact_id: contact.id, tag_id: tagId })),
            { onConflict: 'contact_id,tag_id', ignoreDuplicates: true }
        );
        if (assigned.error) throw assigned.error;
        return true;
    };
}
