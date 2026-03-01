import { describe, it, expect } from 'vitest';
import { replaceTemplateVariables } from '../placeholders';

describe('replaceTemplateVariables', () => {
    const contact = {
        id: 'contact-123',
        psid: 'psid-456',
        page_id: 'page-789',
        name: 'Juan Dela Cruz',
        last_interaction_at: null
    };

    it('should replace {name} with full name', () => {
        const template = 'Hello {name}!';
        expect(replaceTemplateVariables(template, contact)).toBe('Hello Juan Dela Cruz!');
    });

    it('should replace {{name}} with full name', () => {
        const template = 'Hello {{name}}!';
        expect(replaceTemplateVariables(template, contact)).toBe('Hello Juan Dela Cruz!');
    });

    it('should replace {first_name} with first name', () => {
        const template = 'Hi {first_name}!';
        expect(replaceTemplateVariables(template, contact)).toBe('Hi Juan!');
    });

    it('should replace {{first_name}} with first name', () => {
        const template = 'Hi {{first_name}}!';
        expect(replaceTemplateVariables(template, contact)).toBe('Hi Juan!');
    });

    it('should be case-insensitive for placeholders', () => {
        const template = 'HI {FIRST_NAME} AND {{NAME}}!';
        expect(replaceTemplateVariables(template, contact)).toBe('HI Juan AND Juan Dela Cruz!');
    });

    it('should replace {last_name} with last name', () => {
        const template = 'Mr. {last_name}';
        expect(replaceTemplateVariables(template, contact)).toBe('Mr. Dela Cruz');
    });

    it('should replace {firstname} as a variant of first_name', () => {
        const template = 'Greetings {firstname}';
        expect(replaceTemplateVariables(template, contact)).toBe('Greetings Juan');
    });

    it('should replace multiple placeholders in one string', () => {
        const template = '{first_name} {{last_name}} is your name, right {{name}}?';
        expect(replaceTemplateVariables(template, contact)).toBe('Juan Dela Cruz is your name, right Juan Dela Cruz?');
    });

    it('should replace placeholder variants with spaces and dashes', () => {
        const template = 'Hi { first name } {{ last-name }}!';
        expect(replaceTemplateVariables(template, contact)).toBe('Hi Juan Dela Cruz!');
    });

    it('should use "there" as fallback for name if contact name is missing', () => {
        const emptyContact = { ...contact, name: null };
        const template = 'Hello {first_name}!';
        expect(replaceTemplateVariables(template, emptyContact)).toBe('Hello there!');
    });
});
