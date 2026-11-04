import type { getSupabaseAdmin } from './supabase';
import { normalizeContactName } from './contact-names';
import { classifyMessengerSystemMessage, type MessengerSystemSignal } from './messaging-auto-tag';

type Database = ReturnType<typeof getSupabaseAdmin>;
export type MessengerTagMessage = { message?: string; from?: { id?: string } };
export type MessagingAutoTagIds = { paid: string; unqualified: string };
type PageTag = { id: string; name: string; is_default: boolean };

function findTagIds(tags: PageTag[]) {
    const defaults = new Map(tags.filter(tag => tag.is_default)
        .map(tag => [tag.name.toLowerCase().replace(/[^a-z]/g, ''), tag.id]));
    const outcomes = new Map(tags.map(tag => [tag.name.toLowerCase().replace(/[^a-z]/g, ''), tag.id]));
    return {
        paid: defaults.get('paidavailedservice') || defaults.get('paidavailedservices'),
        unqualified: outcomes.get('notqualified') || outcomes.get('unqualified')
    };
}

export async function loadMessagingAutoTagIds(db: Database, pageId: string): Promise<MessagingAutoTagIds> {
    const { data: tags, error } = await db.from('tags').select('id,name,is_default')
        .eq('owner_type', 'page').eq('owner_id', pageId);
    if (error) throw error;
    let ids = findTagIds(tags || []);
    if (!ids.paid || !ids.unqualified) {
        const restored = await db.rpc('ensure_page_default_tags', { p_page_id: pageId });
        if (restored.error) throw new Error(`Could not restore required Page tags: ${restored.error.message || restored.error.code}`);
        ids = findTagIds([...(tags || []), ...(Array.isArray(restored.data) ? restored.data : [])]);
    }
    if (!ids.paid || !ids.unqualified) throw new Error('Required Page tags are missing');
    return { paid: ids.paid, unqualified: ids.unqualified };
}

/** Reuse the same observed Messenger events for imports, echoes, and the background scan. */
export function createContactMessagingAutoTagger(db: Database, page: {
    id: string; fb_page_id: string; messaging_auto_tag_enabled?: boolean;
}, initialIds?: MessagingAutoTagIds) {
    let idsPromise: Promise<MessagingAutoTagIds> | undefined = initialIds ? Promise.resolve(initialIds) : undefined;

    return async (psid: string, messages: MessengerTagMessage[], name?: string): Promise<boolean> => {
        if (page.messaging_auto_tag_enabled === false || !psid || psid === page.fb_page_id) return false;
        const signals = new Set<MessengerSystemSignal>();
        for (const message of messages) {
            if (message.from?.id !== page.fb_page_id) continue;
            const signal = classifyMessengerSystemMessage(message.message || '');
            if (signal) signals.add(signal);
        }
        if (!signals.size) return false;
        if (!idsPromise) {
            idsPromise = loadMessagingAutoTagIds(db, page.id).catch(error => {
                idsPromise = undefined;
                throw error;
            });
        }
        const ids = await idsPromise;
        const targetIds = new Set<string>();
        if (signals.has('unqualified')) targetIds.add(ids.unqualified);
        if ([...signals].some(signal => signal !== 'unqualified')) targetIds.add(ids.paid);

        let { data: contact, error } = await db.from('contacts').select('id')
            .eq('page_id', page.id).eq('psid', psid).maybeSingle();
        if (error) throw error;
        if (!contact) {
            const inserted = await db.from('contacts').insert({
                page_id: page.id, psid, name: normalizeContactName(name)
            }).select('id').single();
            if (inserted.error) {
                const found = await db.from('contacts').select('id')
                    .eq('page_id', page.id).eq('psid', psid).single();
                if (found.error || !found.data) throw inserted.error;
                contact = found.data;
            } else contact = inserted.data;
        }
        if (!contact?.id) throw new Error('Could not resolve contact for Messenger tags');
        const assigned = await db.from('contact_tags').upsert(
            [...targetIds].map(tagId => ({ contact_id: contact.id, tag_id: tagId })),
            { onConflict: 'contact_id,tag_id', ignoreDuplicates: true }
        );
        if (assigned.error) throw assigned.error;
        return true;
    };
}
