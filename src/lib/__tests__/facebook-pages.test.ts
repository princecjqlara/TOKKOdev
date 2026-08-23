import { afterEach, describe, expect, it, vi } from 'vitest';
import { FACEBOOK_REAUTH_MESSAGE } from '../facebook-permissions';
import {
    getConversationIdForPsid,
    getConversationMessages,
    getFacebookPages,
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
