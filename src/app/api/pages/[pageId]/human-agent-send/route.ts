import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getConversationForPsid, sendMessage, sendMessengerMediaAttachment } from '@/lib/facebook';
import { getManualReplyMessagingType } from '@/lib/human-agent-window';
import {
    MAX_MESSENGER_MEDIA_FILES,
    MESSENGER_MEDIA_BUCKET,
    MESSENGER_MEDIA_MIME_TYPES
} from '@/lib/messenger-media';
import { recordOutboundMessageEvent } from '@/lib/outbound-message-events';
import { recordPageActivity } from '@/lib/activity-history';

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) {
            return NextResponse.json({ message: 'Please sign in.' }, { status: 401 });
        }
        const { pageId } = await params;
        const body = await request.json().catch(() => ({}));
        const contactId = typeof body.contactId === 'string' ? body.contactId.trim() : '';
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        const legacyMediaPath = typeof body.mediaPath === 'string' ? body.mediaPath.trim() : '';
        const legacyMediaType = typeof body.mediaType === 'string' ? body.mediaType : '';
        const rawMediaItems = Array.isArray(body.mediaItems)
            ? body.mediaItems
            : legacyMediaPath
                ? [{ path: legacyMediaPath, type: legacyMediaType, partId: 'media:0' }]
                : [];
        const mediaItems = rawMediaItems.map((item: unknown, index: number) => {
            const value = item && typeof item === 'object' ? item as Record<string, unknown> : {};
            return {
                path: typeof value.path === 'string' ? value.path.trim() : '',
                type: typeof value.type === 'string' ? value.type : '',
                partId: typeof value.partId === 'string' ? value.partId : `media:${index}`
            };
        });
        if (!contactId || (!text && mediaItems.length === 0) || text.length > 2000) {
            return NextResponse.json({ message: 'Select one contact and enter text, media, or both (text up to 2,000 characters).' }, { status: 400 });
        }
        if (mediaItems.length > MAX_MESSENGER_MEDIA_FILES) {
            return NextResponse.json({ message: `Choose up to ${MAX_MESSENGER_MEDIA_FILES} media files at a time.` }, { status: 400 });
        }
        const partIds = new Set<string>();
        for (const mediaItem of mediaItems) {
            const ownerPrefix = `${session.user.id}/${pageId}/`;
            const fileName = mediaItem.path.startsWith(ownerPrefix) ? mediaItem.path.slice(ownerPrefix.length) : '';
            const extension = fileName.match(/^[0-9a-f-]{36}\.([a-z0-9]+)$/i)?.[1];
            const supported = Object.values(MESSENGER_MEDIA_MIME_TYPES).some(
                (entry) => entry.extension === extension && entry.type === mediaItem.type
            );
            const validPartId = /^media:\d+$/.test(mediaItem.partId) && !partIds.has(mediaItem.partId);
            if (!supported || !validPartId) {
                return NextResponse.json({ message: 'Upload the media from this page before sending.' }, { status: 400 });
            }
            partIds.add(mediaItem.partId);
        }

        const db = getSupabaseAdmin();
        const { data: access, error: accessError } = await db.from('user_pages')
            .select('page_id').eq('user_id', session.user.id).eq('page_id', pageId).maybeSingle();
        if (accessError) throw accessError;
        if (!access) return NextResponse.json({ message: 'You do not have access to this page.' }, { status: 403 });

        const [{ data: page, error: pageError }, { data: contact, error: contactError }] = await Promise.all([
            db.from('pages').select('fb_page_id,access_token').eq('id', pageId).single(),
            db.from('contacts').select('id,psid,name,last_inbound_at').eq('id', contactId).eq('page_id', pageId).single()
        ]);
        if (pageError) throw pageError;
        if (contactError) throw contactError;
        if (!page?.access_token || !contact?.psid) {
            return NextResponse.json({ message: 'The Page or contact is not ready to send Messenger messages.' }, { status: 400 });
        }
        if (!getManualReplyMessagingType(contact.last_inbound_at)) {
            return NextResponse.json({ message: 'This contact is no longer in the 7-day reply window. Refresh the list.' }, { status: 409 });
        }

        // A synced conversation's updated_time can reflect a Page message. Verify
        // the latest customer message directly with Meta immediately before send.
        const conversation = await getConversationForPsid(page.fb_page_id, contact.psid, page.access_token, { throwOnError: true });
        const latestInbound = (conversation?.messages?.data || [])
            .filter((message) => message.from?.id === contact.psid && message.created_time)
            .sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time))[0];
        const messagingType = getManualReplyMessagingType(latestInbound?.created_time);
        if (!messagingType) {
            return NextResponse.json({ message: 'Meta did not confirm a customer message within the 7-day window. Nothing was sent.' }, { status: 409 });
        }
        if (latestInbound.created_time !== contact.last_inbound_at) {
            const { error: timestampError } = await db.from('contacts')
                .update({ last_inbound_at: latestInbound.created_time })
                .eq('id', contact.id);
            if (timestampError) console.warn('Could not refresh last inbound time:', timestampError.message);
        }

        const preparedMedia: Array<{ type: 'image' | 'video' | 'audio' | 'file'; url: string; partId: string }> = [];
        for (const mediaItem of mediaItems) {
            const { data, error } = await db.storage.from(MESSENGER_MEDIA_BUCKET)
                .createSignedUrl(mediaItem.path, 24 * 60 * 60);
            if (error || !data?.signedUrl) {
                return NextResponse.json({ message: 'One of the uploaded files is no longer available. Upload the files again.' }, { status: 400 });
            }
            preparedMedia.push({
                type: mediaItem.type as 'image' | 'video' | 'audio' | 'file',
                url: data.signedUrl,
                partId: mediaItem.partId
            });
        }

        const sent: Array<{ kind: string; partId: string; messageId: string }> = [];
        try {
            for (const media of preparedMedia) {
                const result = await sendMessengerMediaAttachment(
                    page.fb_page_id, page.access_token, contact.psid,
                    { type: media.type, url: media.url }, messagingType
                );
                sent.push({ kind: media.type, partId: media.partId, messageId: result.message_id });
                await recordOutboundMessageEvent(db, {
                    pageId, contactId, messageId: result.message_id, sourceType: 'manual',
                    actorUserId: session.user.id, actorName: session.user.name || null,
                    messageKind: `${media.type} attachment`
                });
            }
            if (text) {
                const result = await sendMessage(page.fb_page_id, page.access_token, contact.psid, text, messagingType);
                sent.push({ kind: 'text', partId: 'text', messageId: result.message_id });
                await recordOutboundMessageEvent(db, {
                    pageId, contactId, messageId: result.message_id, sourceType: 'manual',
                    actorUserId: session.user.id, actorName: session.user.name || null,
                    messageKind: messagingType
                });
            }
        } catch (error) {
            const partial = sent.length > 0;
            await recordPageActivity(db, {
                pageId, actorUserId: session.user.id, actionType: 'human_agent_manual_reply',
                entityType: 'contact', entityId: contactId,
                status: partial ? 'partial' : 'failed',
                summary: partial ? 'Manual Messenger reply partially sent' : 'Manual Messenger reply failed',
                targetCount: 1, successCount: partial ? 1 : 0, failureCount: partial ? 0 : 1,
                details: {
                    sentKinds: sent.map((item) => item.kind),
                    sentParts: sent.map((item) => item.partId),
                    error: (error as Error).message
                }
            });
            return NextResponse.json({
                message: partial
                    ? `${sent.map((item) => item.kind).join(' and ')} sent, but the rest failed: ${(error as Error).message}. Do not retry without checking Messenger.`
                    : `Could not confirm delivery: ${(error as Error).message}. Check Messenger before retrying.`,
                sent,
                partial
            }, { status: 502 });
        }

        await recordPageActivity(db, {
            pageId, actorUserId: session.user.id, actionType: 'human_agent_manual_reply',
            entityType: 'contact', entityId: contactId, status: 'completed',
            summary: 'Manual Messenger reply sent', targetCount: 1, successCount: 1,
            details: {
                sentKinds: sent.map((item) => item.kind),
                sentParts: sent.map((item) => item.partId),
                messagingType
            }
        });
        return NextResponse.json({ success: true, sent, messagingType });
    } catch (error) {
        console.error('Manual Human Agent send failed:', error);
        return NextResponse.json({ message: 'Could not verify or send this Messenger reply. Nothing was confirmed sent.' }, { status: 500 });
    }
}
