import { describe, expect, it } from 'vitest';
import {
    composeContactName,
    hasUsableContactName,
    normalizeContactName,
    pickPreferredContactName
} from '../contact-names';

describe('normalizeContactName', () => {
    it('returns null for placeholder and empty values', () => {
        expect(normalizeContactName('')).toBeNull();
        expect(normalizeContactName('   ')).toBeNull();
        expect(normalizeContactName('UNKNOWN')).toBeNull();
        expect(normalizeContactName(' Unknown Name ')).toBeNull();
        expect(normalizeContactName('unknown user')).toBeNull();
        expect(normalizeContactName('MESSENGER CONTACT')).toBeNull();
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
        expect(hasUsableContactName('Unknown Name')).toBe(false);
        expect(hasUsableContactName('Messenger Contact')).toBe(false);
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

describe('composeContactName', () => {
    it('builds a usable name from first and last name fields', () => {
        expect(composeContactName(' Jane ', ' Doe ')).toBe('Jane Doe');
    });

    it('returns null when both name parts are empty or placeholders', () => {
        expect(composeContactName('', ' ')).toBeNull();
        expect(composeContactName('Unknown', '')).toBeNull();
    });
});
