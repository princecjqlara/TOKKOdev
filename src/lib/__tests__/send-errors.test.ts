import { describe, expect, it } from 'vitest';
import {
    categorizeSendError,
    isRetryableSendError,
    mergeSendErrors,
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
            categorizeSendError("(#551) This person isn't available right now.")
        ).toBe('recipient_unavailable');

        expect(categorizeSendError('Network timeout')).toBe('other');
    });

    it('marks only unknown category as retryable', () => {
        expect(isRetryableSendError('Server error')).toBe(true);
        expect(
            isRetryableSendError('Requires pages_utility_messaging permission to manage the object')
        ).toBe(false);
        expect(isRetryableSendError("(#551) This person isn't available right now.")).toBe(false);
    });

    it('summarizes send error categories', () => {
        const summary = summarizeSendErrors([
            { contactId: 'a', error: 'Requires pages_utility_messaging permission to manage the object' },
            { contactId: 'b', error: "(#551) This person isn't available right now." },
            { contactId: 'c', error: 'Timeout' },
            { contactId: 'd', error: 'Requires pages_utility_messaging permission to manage the object' }
        ]);

        expect(summary).toEqual({
            utilityPermissionMissing: 2,
            recipientUnavailable: 1,
            other: 1
        });
    });
});
