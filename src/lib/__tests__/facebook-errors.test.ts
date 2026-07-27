import { describe, expect, it } from 'vitest';
import { FACEBOOK_REAUTH_MESSAGE } from '../facebook-permissions';
import { getFacebookConnectErrorMessage, isFacebookReauthMessage } from '../facebook-errors';

describe('facebook connect errors', () => {
    it('normalizes raw Graph /me missing-permissions errors', () => {
        const rawMessage =
            "Unsupported get request. Object with ID 'me' does not exist, cannot be loaded due to missing permissions, or does not support this operation. Please read the Graph API documentation.";

        expect(isFacebookReauthMessage(rawMessage)).toBe(true);
        expect(getFacebookConnectErrorMessage(rawMessage)).toBe(FACEBOOK_REAUTH_MESSAGE);
    });

    it('preserves unrelated errors', () => {
        expect(getFacebookConnectErrorMessage('Facebook rate limit reached')).toBe('Facebook rate limit reached');
    });
});
