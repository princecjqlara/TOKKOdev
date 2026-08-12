import { describe, expect, it } from 'vitest';
import {
    categorizeSendError,
    isRetryableSendError,
    mergeSendErrors,
    shouldPauseCampaignForSendError,
    summarizeSendErrors
} from '../send-errors';

describe('mergeSendErrors', () => {
    it('dedupes by contactId and keeps last error', () => {
        const result = mergeSendErrors([
            [
                { contactId: 'a', error: 'first' },
                { contactId: 'b', error: 'b1' }
            ],
            [{ contactId: 'a', error: 'second' }]
        ]);

        expect(result).toEqual([
            { contactId: 'b', error: 'b1' },
            { contactId: 'a', error: 'second' }
        ]);
    });

    it('skips missing ids and defaults empty errors', () => {
        const result = mergeSendErrors([
            [
                { contactId: '', error: 'x' },
                { contactId: 'c', error: '' }
            ]
        ]);

        expect(result).toEqual([{ contactId: 'c', error: 'Unknown error' }]);
    });

    it('categorizes known facebook send errors', () => {
        expect(
            categorizeSendError('Requires pages_utility_messaging permission to manage the object')
        ).toBe('utility_permission_missing');

        expect(
            categorizeSendError('(#100) Template cannot be found.')
        ).toBe('utility_template_missing');

        expect(
            categorizeSendError("Skipped: utility template not ready for this page. Template 'account_general_notification' exists but status is REJECTED, REJECTED")
        ).toBe('utility_template_missing');

        expect(
            categorizeSendError("(#551) This person isn't available right now.")
        ).toBe('recipient_unavailable');

        expect(
            categorizeSendError(
                '(#10) This message is being sent outside the allowed window. Learn more about the new policy here: https://developers.facebook.com/docs/messenger-platform/policy-overview'
            )
        ).toBe('outside_messaging_window');

        expect(categorizeSendError('(#613) Calls to this api have exceeded the rate limit.')).toBe('rate_limited');
        expect(categorizeSendError('Network timeout')).toBe('transient');
    });

    it('marks only unknown category as retryable', () => {
        expect(isRetryableSendError('Server error')).toBe(true);
        expect(
            isRetryableSendError('Requires pages_utility_messaging permission to manage the object')
        ).toBe(false);
        expect(isRetryableSendError('(#100) Template cannot be found.')).toBe(false);
        expect(
            isRetryableSendError("Skipped: utility template not ready for this page. Template 'account_general_notification' exists but status is REJECTED, REJECTED")
        ).toBe(false);
        expect(isRetryableSendError("(#551) This person isn't available right now.")).toBe(false);
        expect(
            isRetryableSendError(
                '(#10) This message is being sent outside the allowed window. Learn more about the new policy here: https://developers.facebook.com/docs/messenger-platform/policy-overview'
            )
        ).toBe(false);
    });

    it('pauses campaigns for page-wide and recoverable failures', () => {
        expect(shouldPauseCampaignForSendError('(#100) Template cannot be found.')).toBe(true);
        expect(shouldPauseCampaignForSendError('(#613) Calls to this api have exceeded the rate limit.')).toBe(true);
        expect(shouldPauseCampaignForSendError('fetch failed')).toBe(true);
        expect(shouldPauseCampaignForSendError("(#551) This person isn't available right now.")).toBe(false);
    });

    it('summarizes send error categories', () => {
        const summary = summarizeSendErrors([
            { contactId: 'a', error: 'Requires pages_utility_messaging permission to manage the object' },
            {
                contactId: 'x',
                error: "Skipped: utility template not ready for this page. Template 'account_general_notification' exists but status is REJECTED, REJECTED"
            },
            { contactId: 'b', error: "(#551) This person isn't available right now." },
            {
                contactId: 'z',
                error: '(#10) This message is being sent outside the allowed window. Learn more about the new policy here: https://developers.facebook.com/docs/messenger-platform/policy-overview'
            },
            { contactId: 'c', error: 'Timeout' },
            { contactId: 'd', error: 'Requires pages_utility_messaging permission to manage the object' }
        ]);

        expect(summary).toEqual({
            utilityPermissionMissing: 2,
            utilityTemplateMissing: 1,
            recipientUnavailable: 1,
            outsideMessagingWindow: 1,
            rateLimited: 0,
            authenticationRequired: 0,
            transient: 1,
            other: 0
        });
    });
});
