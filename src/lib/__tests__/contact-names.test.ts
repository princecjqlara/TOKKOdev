import { describe, expect, it } from 'vitest';
import {
    hasUsableContactName,
    normalizeContactName,
    pickPreferredContactName
} from '../contact-names';

describe('normalizeContactName', () => {
    it('returns null for placeholder and empty values', () => {
        expect(normalizeContactName('')).toBeNull();
        expect(normalizeContactName('   ')).toBeNull();
        expect(normalizeContactName('UNKNOWN')).toBeNull();
        expect(normalizeContactName('null')).toBeNull();
        expect(normalizeContactName(undefined)).toBeNull();
    });

    it('returns trimmed names for valid values', () => {
        expect(normalizeContactName('  Jane Doe  ')).toBe('Jane Doe');
    });
});

describe('hasUsableContactName', () => {
    it('identifies whether a name can be used', () => {
        expect(hasUsableContactName('Unknown')).toBe(false);
        expect(hasUsableContactName('Prince Lara')).toBe(true);
    });
});

describe('pickPreferredContactName', () => {
    it('chooses the first usable candidate', () => {
        expect(pickPreferredContactName('Unknown', null, '  Contact Name  ')).toBe('Contact Name');
    });

    it('returns null when all candidates are unusable', () => {
        expect(pickPreferredContactName('unknown', '', undefined)).toBeNull();
    });
});
