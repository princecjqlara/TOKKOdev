import { databaseRequest } from './database-request';

export type OutboundMessageSource = 'manual' | 'campaign' | 'automation' | 'welcome';

type SupabaseLike = {
    from: (table: string) => any;
};

export type OutboundMessageEventInput = {
    pageId: string;
    contactId?: string | null;
    messageId: string;
    sourceType: OutboundMessageSource;
    sourceId?: string | null;
    sourceName?: string | null;
    actorUserId?: string | null;
    actorName?: string | null;
    messageKind?: string | null;
    sentAt?: string;
};

let hasWarnedAboutAttributionFailure = false;

function warnOnce(error: unknown) {
    if (hasWarnedAboutAttributionFailure) return;
    hasWarnedAboutAttributionFailure = true;
    console.warn(
        '[OUTBOUND_MESSAGE_EVENT] Failed to record message attribution:',
        error instanceof Error ? error.message : error
    );
}

/**
 * Records enough information to attribute a Facebook Page message during export.
 * Sending must remain successful when the audit migration has not been deployed yet,
 * so audit failures are logged but never re-thrown.
 */
export async function recordOutboundMessageEvent(
    supabase: SupabaseLike,
    event: OutboundMessageEventInput
): Promise<void> {
    await recordOutboundMessageEvents(supabase, [event]);
}

/** Returns false when optional storage failed, so bulk callers can stop probing this slice. */
export async function recordOutboundMessageEvents(
    supabase: SupabaseLike,
    events: OutboundMessageEventInput[]
): Promise<boolean> {
    const validEvents = [...new Map(events
        .filter(event => event.messageId?.trim())
        .map(event => [event.messageId, event])).values()];
    if (validEvents.length === 0) return true;

    try {
        const { error } = await databaseRequest<{ error: { message?: string } | null }>(supabase
            .from('outbound_message_events')
            .upsert(validEvents.map(event => ({
                page_id: event.pageId,
                contact_id: event.contactId || null,
                message_id: event.messageId,
                source_type: event.sourceType,
                source_id: event.sourceId || null,
                source_name: event.sourceName || null,
                actor_user_id: event.actorUserId || null,
                actor_name: event.actorName || null,
                message_kind: event.messageKind || null,
                sent_at: event.sentAt || new Date().toISOString()
            })), { onConflict: 'message_id' }));

        if (error) {
            warnOnce(error.message);
            return false;
        }
        return true;
    } catch (error) {
        warnOnce(error);
        return false;
    }
}
