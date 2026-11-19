import { databaseRequest } from './database-request';
import { classifyMessengerSystemMessage } from './messaging-auto-tag';

export type InquiryEvent = {
    message_id: string;
    kind: 'inbound' | 'outbound' | 'stage';
    source: 'messenger';
    occurred_at: string | null;
    time_basis: 'provider';
    stage?: string;
};

/** Only actual message events start inquiries. Receipts, referrals and postbacks
 * must not manufacture messages or replace missing source times with now(). */
export function inquiryEventFromWebhook(pageFacebookId: string, event: any): { event: InquiryEvent; psid: string } | null {
    if (!event?.message || event.message.is_deleted || event.message.is_unsent) return null;
    const sender = event.sender?.id, recipient = event.recipient?.id;
    if (typeof sender !== 'string' || typeof recipient !== 'string') return null;
    const outbound = sender === pageFacebookId;
    if ((!outbound && recipient !== pageFacebookId) || sender === recipient || !outbound && event.message.is_echo) return null;
    const mid = typeof event.message.mid === 'string' ? event.message.mid : '';
    let at: Date | null = null;
    if (typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)) at = new Date(event.timestamp);
    else if (typeof event.timestamp === 'string' && event.timestamp.trim()) {
        at = /^\d+$/.test(event.timestamp) ? new Date(Number(event.timestamp)) : new Date(event.timestamp);
    }
    const stage = outbound && typeof event.message.text === 'string' ? classifyMessengerSystemMessage(event.message.text) : null;
    return {
        psid: outbound ? recipient : sender,
        event: { message_id: mid, kind: stage ? 'stage' : outbound ? 'outbound' : 'inbound', source: 'messenger',
            occurred_at: at && Number.isFinite(at.getTime()) ? at.toISOString() : null,
            time_basis: 'provider', ...(stage ? { stage } : {}) }
    };
}

export async function captureWebhookInquiry(db: any, pageId: string, pageFacebookId: string, event: any,
    contactId?: string, newContact = false): Promise<void> {
    const parsed = inquiryEventFromWebhook(pageFacebookId, event);
    if (!parsed) return;
    if (!contactId) {
        const contact = await databaseRequest<any>(db.from('contacts').select('id').eq('page_id', pageId).eq('psid', parsed.psid).maybeSingle());
        if (contact.error) throw contact.error;
        contactId = contact.data?.id;
    }
    if (!contactId) return; // An outbound echo never creates a contact.
    const result = await databaseRequest<any>(db.rpc('record_tokko_inquiry_events', {
        p_page: pageId, p_contact: contactId, p_events: [parsed.event], p_new_contact: newContact
    }));
    if (result.error) throw result.error;
}

/** Reuse already-authorized history responses; this performs no Meta reads.
 * Only provider IDs/times after the SQL activation watermark are accepted. */
export async function captureSavedInquiryMessages(db: any, page: { id: string; fb_page_id: string }, psid: string,
    messages: { id?: string; message?: string; from?: { id?: string }; created_time?: string }[]): Promise<void> {
    const events = messages.flatMap(message => {
        if (!message.id || !message.created_time || ![psid, page.fb_page_id].includes(message.from?.id || '')) return [];
        const at = Date.parse(message.created_time);if (!Number.isFinite(at)) return [];
        const parsed = inquiryEventFromWebhook(page.fb_page_id, {
            sender: { id: message.from!.id }, recipient: { id: message.from!.id === psid ? page.fb_page_id : psid },
            timestamp: at, message: { mid: message.id, text: message.message }
        });
        return parsed ? [{ ...parsed.event, collector: 'saved_history' }] : [];
    }).sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
    if (!events.length || !psid || psid === page.fb_page_id) return;
    const contact = await databaseRequest<any>(db.from('contacts').select('id').eq('page_id', page.id).eq('psid', psid).maybeSingle());
    if (contact.error) throw contact.error;if (!contact.data?.id) return;
    for (let offset = 0; offset < events.length; offset += 100) {
        const result = await databaseRequest<any>(db.rpc('record_tokko_inquiry_events', {
            p_page: page.id, p_contact: contact.data.id, p_events: events.slice(offset, offset + 100), p_new_contact: false
        }));
        if (result.error) throw result.error;
    }
}

export type InquiryReport = {
    can_manage: boolean;
    definition_version: string; as_of: string; timezone: string;
    filters: { from: string; to: string; kind: string; horizon_hours: number };
    collection: { started_at: string | null; returning_after_days: number; response_sla_minutes: number;
        last_received_at: string | null; last_event_at: string | null; invalid_events: number; historical_events_ignored: number };
    episodes: { total: number; unique_contacts: number; new_contacts: number; returning_contacts: number; mature: number; provisional: number; censored: number };
    funnel: { qualified: number; order_created: number; converted: number; qualified_rate: number | null; converted_rate: number | null };
    response: { replied: number; human_replied: number; automated_replied: number; unknown_source_messages: number;
        median_minutes: number | null; p90_minutes: number | null; sla_eligible: number; sla_met: number; sla_rate: number | null;
        mature_unanswered: number; unanswered_rate: number | null };
    contact_coverage: { total: number; first_interaction_known: number; last_inbound_known: number; first_interaction_fraction: number | null };
    items: { episode_id: number; contact_id: string; name: string | null; psid: string; kind: string; started_at: string;
        last_inbound_at: string; inbound_messages: number; mature: boolean; first_reply_at: string | null; stage: string }[];
};
