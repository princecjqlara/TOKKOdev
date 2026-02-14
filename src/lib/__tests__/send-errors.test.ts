import { describe, expect, it } from 'vitest';
import { mergeSendErrors } from '../send-errors';

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
});
