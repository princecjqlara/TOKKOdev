import { describe, expect, it } from 'vitest';
import { classifyMessengerSystemMessage, isWithinMessagingAutoTagWindow, MESSAGING_AUTO_TAG_WINDOW_MS } from './messaging-auto-tag';

describe('classifyMessengerSystemMessage', () => {
    it('accepts qualified, converted, and unqualified stage records', () => {
        expect(classifyMessengerSystemMessage('Lead stage set to Qualified')).toBe('qualified');
        expect(classifyMessengerSystemMessage('Lead stage set to Converted')).toBe('converted');
        expect(classifyMessengerSystemMessage('Lead stage set to Lost')).toBe('lost');
        expect(classifyMessengerSystemMessage('Lead stage set to Unqualified')).toBe('unqualified');
        expect(classifyMessengerSystemMessage('Lead stage set to Not Qualified')).toBe('unqualified');
        expect(classifyMessengerSystemMessage(' lead stage set to unqualified. ')).toBe('unqualified');
    });

    it('accepts explicit created and requested order notifications', () => {
        expect(classifyMessengerSystemMessage('You created an order for PHP699. View: fb-pma://payments/orderdetails/?invoice_id=12345')).toBe('order_created');
        expect(classifyMessengerSystemMessage('You requested PHP699. View: fb-pma://payments/orderdetails/?invoice_id=12345')).toBe('order_created');
        expect(classifyMessengerSystemMessage('You created an order for PHP 699.00. View: fb-pma://payments/orderdetails/?invoice_id=12345')).toBe('order_created');
        expect(classifyMessengerSystemMessage('You requested ₱ 699.00. View: fb-pma://payments/orderdetails/?invoice_id=12345')).toBe('order_created');
    });

    it('does not mistake payment claims or ordinary text for a qualifying event', () => {
        expect(classifyMessengerSystemMessage('I paid PHP699')).toBeNull();
        expect(classifyMessengerSystemMessage('You created an order for PHP699')).toBeNull();
    });
});

describe('seven-day auto-tag contact eligibility', () => {
    const now = Date.parse('2026-11-04T00:00:00Z');
    it('includes the exact boundary and excludes older, future, and unknown inbound times', () => {
        expect(isWithinMessagingAutoTagWindow(new Date(now).toISOString(), now)).toBe(true);
        expect(isWithinMessagingAutoTagWindow(new Date(now - MESSAGING_AUTO_TAG_WINDOW_MS).toISOString(), now)).toBe(true);
        for (const value of [null, undefined, 'invalid', new Date(now + 1).toISOString(),
            new Date(now - MESSAGING_AUTO_TAG_WINDOW_MS - 1).toISOString()]) {
            expect(isWithinMessagingAutoTagWindow(value, now)).toBe(false);
        }
    });
});
