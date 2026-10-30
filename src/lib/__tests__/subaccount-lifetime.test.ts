import { describe, expect, it } from 'vitest';
import { subaccountLifetime } from '../subaccount-lifetime';
describe('temporary subaccount lifetime input', () => {
    it('keeps day counts stable for retries and leaves existing lifetimes unchanged when omitted', () => {
        expect(subaccountLifetime({ lifetimeDays: 7, deleteAfterExpiry: true })).toEqual({ days: 7, expiresAt: undefined, deleteAfterExpiry: true });
        expect(subaccountLifetime({})).toEqual({ days: null, expiresAt: undefined, deleteAfterExpiry: undefined });
        expect(subaccountLifetime({ expiresAt: null, deleteAfterExpiry: false })).toEqual({ days: null, expiresAt: null, deleteAfterExpiry: false });
    });
    it.each([0, -1, 1.5, 3651, '7', false])('rejects invalid day counts: %s', lifetimeDays => {
        expect(() => subaccountLifetime({ lifetimeDays })).toThrow();
    });
    it('rejects ambiguous deadlines and non-boolean deletion flags', () => {
        expect(() => subaccountLifetime({ lifetimeDays: 7, expiresAt: '2099-01-01T00:00:00Z' })).toThrow();
        expect(() => subaccountLifetime({ deleteAfterExpiry: 'true' })).toThrow();
    });
});
