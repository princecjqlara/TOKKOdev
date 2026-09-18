import { describe, expect, it } from 'vitest';
import { classifyMessengerSystemMessage } from './messaging-auto-tag';

describe('classifyMessengerSystemMessage', () => {
    it('accepts qualified and converted stage records', () => {
        expect(classifyMessengerSystemMessage('Lead stage set to Qualified')).toBe('qualified');
        expect(classifyMessengerSystemMessage('Lead stage set to Converted')).toBe('converted');
    });

    it('accepts explicit created and requested order notifications', () => {
        expect(classifyMessengerSystemMessage('You created an order for PHP699. View: fb-pma://payments/orderdetails/?invoice_id=12345')).toBe('order_created');
        expect(classifyMessengerSystemMessage('You requested PHP699. View: fb-pma://payments/orderdetails/?invoice_id=12345')).toBe('order_created');
    });

    it('does not mistake payment claims or ordinary text for a qualifying event', () => {
        expect(classifyMessengerSystemMessage('I paid PHP699')).toBeNull();
        expect(classifyMessengerSystemMessage('You created an order for PHP699')).toBeNull();
    });
});
