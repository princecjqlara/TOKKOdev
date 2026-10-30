import { describe, expect, it } from 'vitest';
import { isSubaccount, needsSubaccountProfile, subaccountProfileInput } from '../subaccount-profile';

describe('first-login team profile', () => {
    it('requires the step only for an incomplete new subaccount', () => {
        const account = { account_kind: 'email', created_by: 'parent', profile_required: true, profile_completed_at: null };
        expect(needsSubaccountProfile(account)).toBe(true);
        expect(needsSubaccountProfile({ ...account, profile_completed_at: '2026-10-31T00:00:00Z' })).toBe(false);
        expect(needsSubaccountProfile({ ...account, profile_required: false })).toBe(false);
        expect(needsSubaccountProfile({ account_kind: 'facebook', profile_required: true })).toBe(false);
        expect(needsSubaccountProfile({ account_kind: 'legacy', profile_required: true })).toBe(false);
        expect(isSubaccount({ account_kind: 'invited' })).toBe(true);
    });
    it.each([
        ['0912 345 6789', '+639123456789'], ['639123456789', '+639123456789'],
        ['+63 (912) 345-6789', '+639123456789'], ['0044 7700 900123', '+447700900123'], ['+1 212 555 1234', '+12125551234']
    ])('normalizes phone %s without losing the country code', (phone, expected) => {
        expect(subaccountProfileInput({ name: '  Ana  María  ', phone })).toEqual({ name: 'Ana María', phone: expected });
    });
    it.each([null, [], {}, { name: '', phone: '+639123456789' }, { name: 'x'.repeat(101), phone: '+639123456789' },
        { name: 'A\u0000B', phone: '+639123456789' }, { name: 'Ana', phone: '123' }, { name: 'Ana', phone: '+00000000000' },
        { name: 'Ana', phone: '+639123456789 ext 2' }, { name: 'Ana', phone: '+1234567890123456' }].map(body => ({ body })))('rejects invalid details: %j', ({ body }) => {
        expect(() => subaccountProfileInput(body)).toThrow();
    });
});
