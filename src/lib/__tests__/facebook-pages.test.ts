import { afterEach, describe, expect, it, vi } from 'vitest';
import { FACEBOOK_REAUTH_MESSAGE } from '../facebook-permissions';
import { getFacebookPages, isFacebookReauthRequired } from '../facebook';

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
