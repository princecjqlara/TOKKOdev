import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendMessage, sendUtilityMessage, takeThreadControl } from '../facebook';

function createJsonResponse(ok: boolean, payload: unknown, status: number = 200, statusText: string = 'OK') {
    return {
        ok,
        status,
        statusText,
        json: vi.fn().mockResolvedValue(payload)
    } as unknown as Response;
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('sendMessage', () => {
    it('rejects invalid utility parameters before calling Facebook', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await expect(sendMessage(
            'page_1',
            'token_1',
            'psid_1',
            'Promo #1 💇',
            'UTILITY'
        )).rejects.toThrow('Unsupported utility template parameter');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('uses default utility template with en_US language', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(createJsonResponse(true, { message_id: 'mid.1' }));
        vi.stubGlobal('fetch', fetchMock);

        await sendMessage('page_1', 'token_1', 'psid_1', 'hello', 'UTILITY');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [requestUrl, requestInit] = fetchMock.mock.calls[0];
        expect(requestUrl).toBe('https://graph.facebook.com/v21.0/me/messages?access_token=token_1');

        const payload = JSON.parse((requestInit as RequestInit).body as string);
        expect(payload.messaging_type).toBe('UTILITY');
        expect(payload.message.template.name).toBe('account_general_notification');
        expect(payload.message.template.language.code).toBe('en_US');
    });

    it('supports custom template and language for utility sends', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(createJsonResponse(true, { message_id: 'mid.2' }));
        vi.stubGlobal('fetch', fetchMock);

        await sendMessage(
            'page_1',
            'token_1',
            'psid_1',
            'hola',
            'UTILITY',
            'account_update_notification',
            'es_ES'
        );

        const [, requestInit] = fetchMock.mock.calls[0];
        const payload = JSON.parse((requestInit as RequestInit).body as string);
        expect(payload.message.template.name).toBe('account_update_notification');
        expect(payload.message.template.language.code).toBe('es_ES');
    });

    it('supports utility templates without body parameters', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(createJsonResponse(true, { message_id: 'mid.no-params' }));
        vi.stubGlobal('fetch', fetchMock);

        await sendMessage(
            'page_1',
            'token_1',
            'psid_1',
            'ignored',
            'UTILITY',
            'active_chatbot_auto',
            'en_US',
            []
        );

        const [, requestInit] = fetchMock.mock.calls[0];
        const payload = JSON.parse((requestInit as RequestInit).body as string);
        expect(payload.message.template.name).toBe('active_chatbot_auto');
        expect(payload.message.template.language.code).toBe('en_US');
        expect(payload.message.template.components).toBeUndefined();
    });

    it('throws facebook api error message when send fails', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                createJsonResponse(false, { error: { message: '(#100) Template cannot be found.' } }, 400, 'Bad Request')
            );
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            sendMessage('page_1', 'token_1', 'psid_1', 'hello', 'UTILITY')
        ).rejects.toThrow('(#100) Template cannot be found.');
    });

    it('sends HUMAN_AGENT messages as MESSAGE_TAG payloads', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(createJsonResponse(true, { message_id: 'mid.3' }));
        vi.stubGlobal('fetch', fetchMock);

        await sendMessage('page_1', 'token_1', 'psid_1', 'hello', 'HUMAN_AGENT');

        const [, requestInit] = fetchMock.mock.calls[0];
        const payload = JSON.parse((requestInit as RequestInit).body as string);
        expect(payload.messaging_type).toBe('MESSAGE_TAG');
        expect(payload.tag).toBe('HUMAN_AGENT');
        expect(payload.message.text).toBe('hello');
    });

    it('sends RESPONSE button template payload when buttons are provided', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(createJsonResponse(true, { message_id: 'mid.response.buttons' }));
        vi.stubGlobal('fetch', fetchMock);

        await sendMessage(
            'page_1',
            'token_1',
            'psid_1',
            'Need help with your booking?',
            'RESPONSE',
            undefined,
            'en_US',
            undefined,
            [
                { type: 'URL', text: 'Book now', url: 'https://example.com/book' },
                { type: 'POSTBACK', text: 'Talk to sales', payload: 'talk_sales' }
            ]
        );

        const [, requestInit] = fetchMock.mock.calls[0];
        const payload = JSON.parse((requestInit as RequestInit).body as string);
        expect(payload.messaging_type).toBe('RESPONSE');
        expect(payload.message.attachment.type).toBe('template');
        expect(payload.message.attachment.payload.template_type).toBe('button');
        expect(payload.message.attachment.payload.text).toBe('Need help with your booking?');
        expect(payload.message.attachment.payload.buttons).toEqual([
            {
                type: 'web_url',
                title: 'Book now',
                url: 'https://example.com/book'
            },
            {
                type: 'postback',
                title: 'Talk to sales',
                payload: 'talk_sales'
            }
        ]);
    });

    it('sends UTILITY message with buttons (buttons are in template, not payload)', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(createJsonResponse(true, { message_id: 'mid.btn' }));
        vi.stubGlobal('fetch', fetchMock);

        const buttons = [
            { type: 'URL' as const, text: 'View Details', url: 'https://example.com/details' },
            { type: 'URL' as const, text: 'Contact Us', url: 'https://example.com/contact' }
        ];

        await sendMessage(
            'page_1',
            'token_1',
            'psid_1',
            'Your order is ready',
            'UTILITY',
            'order_notification',
            'en_US',
            ['Your order is ready'],
            buttons
        );

        const [, requestInit] = fetchMock.mock.calls[0];
        const payload = JSON.parse((requestInit as RequestInit).body as string);
        expect(payload.messaging_type).toBe('UTILITY');
        expect(payload.message.template.name).toBe('order_notification');

        const components = payload.message.template.components;
        // Only body component — buttons are static in the template definition
        expect(components).toHaveLength(1);
        expect(components[0].type).toBe('body');
        expect(components[0].parameters[0].text).toBe('Your order is ready');
    });

    it('sends UTILITY template with dynamic image header and body text', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(createJsonResponse(true, { message_id: 'mid.media' }));
        vi.stubGlobal('fetch', fetchMock);

        await sendMessage(
            'page_1',
            'token_1',
            'psid_1',
            'Your appointment is confirmed',
            'UTILITY',
            'idle_salon_image_update_v2',
            'en_US',
            ['Your appointment is confirmed'],
            undefined,
            { type: 'image', url: 'https://example.com/updated-photo.jpg' }
        );

        const [, requestInit] = fetchMock.mock.calls[0];
        const payload = JSON.parse((requestInit as RequestInit).body as string);
        expect(payload.messaging_type).toBe('UTILITY');
        expect(payload.message.template.name).toBe('idle_salon_image_update_v2');
        expect(payload.message.template.components).toEqual([
            {
                type: 'header',
                parameters: [
                    {
                        type: 'image',
                        url: 'https://example.com/updated-photo.jpg'
                    }
                ]
            },
            {
                type: 'body',
                parameters: [
                    {
                        type: 'text',
                        text: 'Your appointment is confirmed'
                    }
                ]
            }
        ]);
    });

    it('does not include buttons for HUMAN_AGENT messages', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(createJsonResponse(true, { message_id: 'mid.no-btn' }));
        vi.stubGlobal('fetch', fetchMock);

        const buttons = [
            { type: 'URL' as const, text: 'View', url: 'https://example.com' }
        ];

        await sendMessage(
            'page_1',
            'token_1',
            'psid_1',
            'hello',
            'HUMAN_AGENT',
            undefined,
            'en_US',
            undefined,
            buttons
        );

        const [, requestInit] = fetchMock.mock.calls[0];
        const payload = JSON.parse((requestInit as RequestInit).body as string);
        expect(payload.messaging_type).toBe('MESSAGE_TAG');
        expect(payload.tag).toBe('HUMAN_AGENT');
        expect(payload.message.text).toBe('hello');
        // No template or button components for HUMAN_AGENT
        expect(payload.message.template).toBeUndefined();
    });

});

describe('takeThreadControl', () => {
    it('uses the Messenger Handover Protocol endpoint for the recipient', async () => {
        const fetchMock = vi.fn().mockResolvedValue(createJsonResponse(true, { success: true }));
        vi.stubGlobal('fetch', fetchMock);

        await takeThreadControl('page_token', 'psid_1', 'campaign recovery');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [requestUrl, requestInit] = fetchMock.mock.calls[0];
        expect(requestUrl).toBe('https://graph.facebook.com/v21.0/me/take_thread_control?access_token=page_token');
        expect(JSON.parse((requestInit as RequestInit).body as string)).toEqual({
            recipient: { id: 'psid_1' },
            metadata: 'campaign recovery'
        });
    });
});

describe('sendUtilityMessage validation', () => {
    it('rejects invalid body parameters before calling Facebook', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await expect(sendUtilityMessage(
            'page_1',
            'token_1',
            'psid_1',
            'idle_salon_image_update_v2',
            'en_US',
            'Promo 20% off'
        )).rejects.toThrow('Unsupported utility template parameter');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('sendUtilityMessage', () => {
    it('sends template media header when provided', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(createJsonResponse(true, { message_id: 'mid.utility.media', recipient_id: 'psid_1' }));
        vi.stubGlobal('fetch', fetchMock);

        await sendUtilityMessage(
            'page_1',
            'token_1',
            'psid_1',
            'idle_salon_image_update_v2',
            'en_US',
            ['Your appointment moved to 4 PM'],
            { type: 'image', url: 'https://example.com/changed-photo.png' }
        );

        const [requestUrl, requestInit] = fetchMock.mock.calls[0];
        expect(requestUrl).toBe('https://graph.facebook.com/v21.0/page_1/messages?access_token=token_1');

        const payload = JSON.parse((requestInit as RequestInit).body as string);
        expect(payload.message.template.components[0]).toEqual({
            type: 'header',
            parameters: [
                {
                    type: 'image',
                    url: 'https://example.com/changed-photo.png'
                }
            ]
        });
    });
});
