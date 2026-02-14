import { describe, expect, it } from 'vitest';
import { normalizeCampaignRecipientErrors } from '../campaign-errors';

describe('normalizeCampaignRecipientErrors', () => {
    it('handles contact objects and arrays with fallback error', () => {
        const result = normalizeCampaignRecipientErrors([
            {
                id: '1',
                contact_id: 'c1',
                status: 'failed',
                error_message: 'Oops',
                contacts: { name: 'Alice', psid: 'p1' }
            },
            {
                id: '2',
                contact_id: 'c2',
                status: 'failed',
                error_message: null,
                contacts: [{ name: null, psid: 'p2' }]
            }
        ]);

        expect(result).toEqual([
            {
                id: '1',
                contactId: 'c1',
                contactName: 'Alice',
                contactPsid: 'p1',
                error: 'Oops'
            },
            {
                id: '2',
                contactId: 'c2',
                contactName: null,
                contactPsid: 'p2',
                error: 'Unknown error'
            }
        ]);
    });
});
