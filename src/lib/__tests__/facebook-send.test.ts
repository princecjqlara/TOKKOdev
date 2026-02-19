import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendMessage } from '../facebook';

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

});
