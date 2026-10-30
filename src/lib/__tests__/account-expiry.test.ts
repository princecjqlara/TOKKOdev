import { describe, expect, it } from 'vitest';
import { accountHasExpired, parseAccountExpiry } from '../account-expiry';

describe('account expiry boundaries', () => {
    it('treats the exact deadline and invalid stored values as expired', () => {
        const deadline = '2030-01-01T00:00:00Z';
        const now = Date.parse(deadline);
        expect(accountHasExpired(deadline, now - 1)).toBe(false);
        expect(accountHasExpired(deadline, now)).toBe(true);
        expect(accountHasExpired('invalid', now)).toBe(true);
        expect(accountHasExpired(null, now)).toBe(false);
    });
    it('preserves omission, supports removal, and normalizes explicit timezones', () => {
        expect(parseAccountExpiry(undefined)).toBeUndefined();
        expect(parseAccountExpiry(null)).toBeNull();
        expect(parseAccountExpiry('2099-01-01T08:00:00+08:00')).toBe('2099-01-01T00:00:00.000Z');
        expect(() => parseAccountExpiry('2099-01-01T08:00:00')).toThrow();
        expect(() => parseAccountExpiry('')).toThrow();
    });
    it.each(['2099-02-29T00:00:00Z', '2100-02-29T00:00:00Z', '2099-02-31T08:00:00+08:00', '2099-04-31T00:00:00Z', '2099-01-01T24:00:00Z'])('rejects deadlines that JavaScript would silently normalize: %s', value => {
        expect(() => parseAccountExpiry(value)).toThrow();
    });
    it('accepts real leap days and timezone offsets that cross a calendar boundary', () => {
        expect(parseAccountExpiry('2400-02-29T00:00:00Z')).toBe('2400-02-29T00:00:00.000Z');
        expect(parseAccountExpiry('2099-03-01T00:30:00+08:00')).toBe('2099-02-28T16:30:00.000Z');
    });
});
