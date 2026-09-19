import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    getConversationForPsid: vi.fn(),
    sendMessage: vi.fn(),
    sendMessengerMediaAttachment: vi.fn(),
    recordOutboundMessageEvent: vi.fn(),
    recordPageActivity: vi.fn()
}));

vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: mocks.getSessionFromRequest }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));
vi.mock('@/lib/facebook', () => ({
    getConversationForPsid: mocks.getConversationForPsid,
    sendMessage: mocks.sendMessage,
    sendMessengerMediaAttachment: mocks.sendMessengerMediaAttachment
}));
vi.mock('@/lib/outbound-message-events', () => ({ recordOutboundMessageEvent: mocks.recordOutboundMessageEvent }));
vi.mock('@/lib/activity-history', () => ({ recordPageActivity: mocks.recordPageActivity }));

import { POST } from './route';

const lastInbound = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
const mediaPath = 'user-1/page-1/123e4567-e89b-12d3-a456-426614174000.png';

function makeQuery(result: Record<string, unknown>) {
    return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue(result),
        single: vi.fn().mockResolvedValue(result),
        update: vi.fn().mockReturnThis()
    };
}

function request(body: Record<string, unknown>) {
    return new NextRequest('http://localhost/api/pages/page-1/human-agent-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

describe('manual Human Agent reply', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'user-1', name: 'Agent' } });
        const tables: Record<string, ReturnType<typeof makeQuery>> = {
            user_pages: makeQuery({ data: { page_id: 'page-1' }, error: null }),
            pages: makeQuery({ data: { fb_page_id: 'fb-page-1', access_token: 'token' }, error: null }),
            contacts: makeQuery({ data: { id: 'contact-1', psid: 'psid-1', name: 'Customer', last_inbound_at: lastInbound }, error: null })
        };
        mocks.getSupabaseAdmin.mockReturnValue({
            from: (table: string) => tables[table],
            storage: { from: () => ({ createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://example.com/media.png' }, error: null }) }) }
        });
        mocks.getConversationForPsid.mockResolvedValue({
            messages: { data: [{ from: { id: 'psid-1' }, created_time: lastInbound }] }
        });
        mocks.sendMessage.mockResolvedValue({ message_id: 'text-message' });
        mocks.sendMessengerMediaAttachment.mockResolvedValue({ message_id: 'media-message' });
        mocks.recordOutboundMessageEvent.mockResolvedValue(undefined);
        mocks.recordPageActivity.mockResolvedValue(true);
    });

    it('rejects a contact whose most recent customer message is outside 7 days', async () => {
        mocks.getConversationForPsid.mockResolvedValue({
            messages: { data: [{ from: { id: 'psid-1' }, created_time: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() }] }
        });
        const response = await POST(request({ contactId: 'contact-1', text: 'Hello' }), { params: Promise.resolve({ pageId: 'page-1' }) });
        expect(response.status).toBe(409);
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('sends media and text as separate messages to one verified contact', async () => {
        const response = await POST(request({
            contactId: 'contact-1', text: 'Here is the information', mediaPath, mediaType: 'image'
        }), { params: Promise.resolve({ pageId: 'page-1' }) });
        expect(response.status).toBe(200);
        expect(mocks.sendMessengerMediaAttachment).toHaveBeenCalledWith(
            'fb-page-1', 'token', 'psid-1', { type: 'image', url: 'https://example.com/media.png' }, 'HUMAN_AGENT'
        );
        expect(mocks.sendMessage).toHaveBeenCalledWith('fb-page-1', 'token', 'psid-1', 'Here is the information', 'HUMAN_AGENT');
        expect(mocks.recordOutboundMessageEvent).toHaveBeenCalledTimes(2);
    });

    it('sends multiple media files from one action', async () => {
        const secondMediaPath = 'user-1/page-1/223e4567-e89b-12d3-a456-426614174000.pdf';
        const response = await POST(request({
            contactId: 'contact-1',
            mediaItems: [
                { path: mediaPath, type: 'image', partId: 'media:0' },
                { path: secondMediaPath, type: 'file', partId: 'media:1' }
            ]
        }), { params: Promise.resolve({ pageId: 'page-1' }) });

        expect(response.status).toBe(200);
        expect(mocks.sendMessengerMediaAttachment).toHaveBeenCalledTimes(2);
        expect(mocks.sendMessengerMediaAttachment).toHaveBeenNthCalledWith(
            1, 'fb-page-1', 'token', 'psid-1',
            { type: 'image', url: 'https://example.com/media.png' }, 'HUMAN_AGENT'
        );
        expect(mocks.sendMessengerMediaAttachment).toHaveBeenNthCalledWith(
            2, 'fb-page-1', 'token', 'psid-1',
            { type: 'file', url: 'https://example.com/media.png' }, 'HUMAN_AGENT'
        );
        const body = await response.json();
        expect(body.sent.map((item: { partId: string }) => item.partId)).toEqual(['media:0', 'media:1']);
    });

    it('does not permit using another uploader’s media path', async () => {
        const response = await POST(request({
            contactId: 'contact-1', mediaPath: mediaPath.replace('user-1', 'other-user'), mediaType: 'image'
        }), { params: Promise.resolve({ pageId: 'page-1' }) });
        expect(response.status).toBe(400);
        expect(mocks.sendMessengerMediaAttachment).not.toHaveBeenCalled();
    });

    it('uses a standard response when the customer messaged less than 24 hours ago', async () => {
        const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        mocks.getConversationForPsid.mockResolvedValue({
            messages: { data: [{ from: { id: 'psid-1' }, created_time: recent }] }
        });
        const response = await POST(request({ contactId: 'contact-1', text: 'Hello' }), { params: Promise.resolve({ pageId: 'page-1' }) });
        expect(response.status).toBe(200);
        expect(mocks.sendMessage).toHaveBeenCalledWith('fb-page-1', 'token', 'psid-1', 'Hello', 'RESPONSE');
    });

    it('reports partial delivery without retrying the successful media message', async () => {
        mocks.sendMessage.mockRejectedValue(new Error('Text failed'));
        const response = await POST(request({
            contactId: 'contact-1', text: 'Hello', mediaPath, mediaType: 'image'
        }), { params: Promise.resolve({ pageId: 'page-1' }) });
        expect(response.status).toBe(502);
        const body = await response.json();
        expect(body.partial).toBe(true);
        expect(body.sent).toEqual([{ kind: 'image', partId: 'media:0', messageId: 'media-message' }]);
        expect(mocks.sendMessengerMediaAttachment).toHaveBeenCalledTimes(1);
    });
});
