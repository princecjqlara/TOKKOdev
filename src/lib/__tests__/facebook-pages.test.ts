import { afterEach, describe, expect, it, vi } from 'vitest';
import { FACEBOOK_REAUTH_MESSAGE } from '../facebook-permissions';
import {
    getConversationForPsid,
    getConversationIdForPsid,
    getConversationMessages,
    getFacebookPages,
    getPageConversationsBatch,
    isFacebookReauthRequired
} from '../facebook';

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

describe('getFacebookPages', () => {
    it('classifies Facebook /me permission failures as reauthorization required', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            createJsonResponse(
                false,
                {
                    error: {
                        message: "Unsupported get request. Object with ID 'me' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
                        type: 'GraphMethodException',
                        code: 100
                    }
                },
                400,
                'Bad Request'
            )
        );
        vi.stubGlobal('fetch', fetchMock);

        await expect(getFacebookPages('user token with spaces')).rejects.toMatchObject({
            name: 'FacebookGraphApiError',
            requiresReauth: true,
            message: FACEBOOK_REAUTH_MESSAGE
        });

        const [requestUrl] = fetchMock.mock.calls[0];
        expect((requestUrl as URL).searchParams.get('access_token')).toBe('user token with spaces');
    });

    it('detects reauthorization errors from message text', () => {
        expect(
            isFacebookReauthRequired(
                new Error("Unsupported get request. Object with ID 'me' does not exist due to missing permissions.")
            )
        ).toBe(true);
    });
});

describe('strict conversation reads', () => {
    it('reuses embedded messages and follows paging links even after a short page', async () => {
        const nextPage = 'https://graph.facebook.com/messages-next';
        const finalPage = 'https://graph.facebook.com/messages-final';
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(createJsonResponse(true, {
                data: [{
                    id: 'message_2', message: 'Second', from: { id: 'page_1' },
                    created_time: '2026-09-09T00:01:00.000Z'
                }],
                paging: { next: finalPage }
            }))
            .mockResolvedValueOnce(createJsonResponse(true, {
                data: [{
                    id: 'message_3', message: 'Third', from: { id: 'psid_1' },
                    created_time: '2026-09-09T00:02:00.000Z'
                }]
            }));
        vi.stubGlobal('fetch', fetchMock);

        const messages = await getConversationMessages(
            'conversation_1',
            'page_token',
            Number.MAX_SAFE_INTEGER,
            {
                throwOnError: true,
                initialPage: {
                    data: [{
                        id: 'message_1', message: 'First', from: { id: 'psid_1' },
                        created_time: '2026-09-09T00:00:00.000Z'
                    }],
                    paging: { next: nextPage }
                }
            }
        );

        expect(messages.map((message) => message.id)).toEqual(['message_1', 'message_2', 'message_3']);
        expect(fetchMock).toHaveBeenNthCalledWith(1, nextPage, expect.any(Object));
        expect(fetchMock).toHaveBeenNthCalledWith(2, finalPage, expect.any(Object));
    });

    it('exports every message when a conversation is longer than the embedded 100-message page', async () => {
        const nextPage = 'https://graph.facebook.com/conversation_1/messages?after=page_2';
        const embeddedMessages = Array.from({ length: 100 }, (_, index) => ({
            id: `message_${index + 1}`,
            message: `Message ${index + 1}`,
            from: { id: index % 2 === 0 ? 'psid_1' : 'page_1' },
            created_time: `2026-09-09T00:${String(index % 60).padStart(2, '0')}:00.000Z`
        }));
        const finalMessages = [101, 102].map((number) => ({
            id: `message_${number}`,
            message: `Message ${number}`,
            from: { id: 'psid_1' },
            created_time: '2026-09-09T02:00:00.000Z'
        }));
        const fetchMock = vi.fn().mockResolvedValue(
            createJsonResponse(true, { data: finalMessages })
        );
        vi.stubGlobal('fetch', fetchMock);

        const messages = await getConversationMessages(
            'conversation_1',
            'page_token',
            Number.MAX_SAFE_INTEGER,
            {
                throwOnError: true,
                initialPage: {
                    data: embeddedMessages,
                    paging: { next: nextPage }
                }
            }
        );

        expect(messages).toHaveLength(102);
        expect(messages.map((message) => message.id)).toEqual([
            ...embeddedMessages.map((message) => message.id),
            'message_101',
            'message_102'
        ]);
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock).toHaveBeenCalledWith(nextPage, expect.any(Object));
    });

    it('can include the first page of messages in a conversation batch', async () => {
        const fetchMock = vi.fn().mockResolvedValue(createJsonResponse(true, { data: [] }));
        vi.stubGlobal('fetch', fetchMock);

        await getPageConversationsBatch('page_1', 'page_token', {
            limit: 50,
            includeMessages: true
        });

        const requestUrl = new URL(fetchMock.mock.calls[0][0]);
        expect(requestUrl.searchParams.get('fields')).toContain('messages.limit(100)');
        expect(requestUrl.searchParams.get('limit')).toBe('50');
    });

    it('loads a selected contact conversation and its first message page together', async () => {
        const conversation = {
            id: 'conversation_1',
            participants: { data: [{ id: 'psid_1', name: 'Customer' }] },
            messages: { data: [{ id: 'message_1', message: 'Hello' }] }
        };
        const fetchMock = vi.fn().mockResolvedValue(createJsonResponse(true, { data: [conversation] }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            getConversationForPsid('page_1', 'psid_1', 'page token', { throwOnError: true })
        ).resolves.toEqual(conversation);

        const requestUrl = new URL(fetchMock.mock.calls[0][0]);
        expect(requestUrl.searchParams.get('user_id')).toBe('psid_1');
        expect(requestUrl.searchParams.get('fields')).toContain('messages.limit(100)');
        expect(requestUrl.searchParams.get('access_token')).toBe('page token');
    });

    it('throws a classified Graph error instead of exporting an incomplete message history', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            createJsonResponse(
                false,
                {
                    error: {
                        message: 'Error validating access token: Session has expired.',
                        type: 'OAuthException',
                        code: 190
                    }
                },
                400,
                'Bad Request'
            )
        ));

        await expect(
            getConversationMessages('conversation_1', 'expired_token', 500, { throwOnError: true })
        ).rejects.toMatchObject({
            name: 'FacebookGraphApiError',
            requiresReauth: true
        });
    });

    it('throws when a selected contact conversation lookup fails', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            createJsonResponse(
                false,
                { error: { message: 'Temporarily unavailable', code: 2 } },
                503,
                'Service Unavailable'
            )
        ));

        await expect(
            getConversationIdForPsid('page_1', 'psid_1', 'page_token', { throwOnError: true })
        ).rejects.toMatchObject({
            name: 'FacebookGraphApiError',
            status: 503
        });
    });

    it('skips a stale selected contact when Facebook reports no matching user', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            createJsonResponse(
                false,
                { error: { message: 'No matching user found', code: 100 } },
                400,
                'Bad Request'
            )
        ));

        await expect(
            getConversationIdForPsid('page_1', 'stale_psid', 'page_token', { throwOnError: true })
        ).resolves.toBeNull();
    });

    it('stops a repeated Facebook message cursor instead of looping forever', async () => {
        const repeatedUrl = 'https://graph.facebook.com/repeated-page';
        const messages = Array.from({ length: 100 }, (_, index) => ({
            id: `message_${index}`,
            message: `Message ${index}`,
            from: { id: 'psid_1' },
            created_time: '2026-08-24T00:00:00.000Z'
        }));
        vi.stubGlobal('fetch', vi.fn()
            .mockResolvedValueOnce(createJsonResponse(true, {
                data: messages,
                paging: { next: repeatedUrl }
            }))
            .mockResolvedValueOnce(createJsonResponse(true, {
                data: messages,
                paging: { next: repeatedUrl }
            }))
        );

        await expect(
            getConversationMessages('conversation_1', 'page_token', 500, { throwOnError: true })
        ).rejects.toThrow('repeated message-history cursor');
    });
});
