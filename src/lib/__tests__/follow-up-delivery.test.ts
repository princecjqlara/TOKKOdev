import { describe, expect, it } from 'vitest';
import { followUpNeedsTemplate, followUpStepError, followUpTemplateError, getFollowUpMessagingType, getFollowUpTemplates } from '../follow-up-delivery';

const raw = { name: 'reminder', language: 'en_US', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hello {{1}}, your appointment is {{2}}.' }] };
const step = { message_text: 'Hello', delay_minutes: 60 };
describe('follow-up delivery selection', () => {
    it('uses only a real inbound timestamp to select the available window', () => {
        const now = new Date('2026-11-04T00:00:00Z');
        expect(getFollowUpMessagingType('2026-11-03T23:00:00Z', now)).toBe('RESPONSE');
        expect(getFollowUpMessagingType('2026-11-02T00:00:00Z', now)).toBe('HUMAN_AGENT');
        for (const inbound of [null, undefined, 'invalid', '2026-10-28T00:00:00Z', '2026-11-05T00:00:00Z']) {
            expect(getFollowUpMessagingType(inbound, now)).toBe('UTILITY');
        }
    });
    it('adds step delays and requires a selection at the seven-day boundary', () => {
        const steps = [{ ...step, delay_minutes: 6 * 1440 }, { ...step, delay_minutes: 1440 }];
        expect(followUpNeedsTemplate(steps, 0)).toBe(false);
        expect(followUpNeedsTemplate(steps, 1)).toBe(true);
        expect(followUpStepError(steps)).toContain('Step 2: choose');
        steps[1] = { ...steps[1], template_name: 'reminder' } as typeof step;
        expect(followUpStepError(steps)).toBeNull();
    });
    it('only lists approved utility templates with supported parameters', () => {
        const templates = getFollowUpTemplates([raw, { ...raw, status: 'PENDING' }, { ...raw, category: 'MARKETING' },
            { ...raw, components: [{ type: 'BODY', text: 'Hi {{3}}' }] },
            { ...raw, components: [{ type: 'BODY', text: '{{name}}' }] }]);
        expect(templates).toEqual([{ name: 'reminder', language: 'en_US', body: raw.components[0].text, parameterCount: 2, mediaType: null }]);
    });
    it('requires the exact selected template, language, and parameter values', () => {
        const templates = getFollowUpTemplates([raw]);
        const configured = { ...step, template_name: 'reminder', template_language: 'en_US', template_parameters: ['{{first_name}}', 'tomorrow'] };
        expect(followUpTemplateError(configured, templates)).toBeNull();
        expect(followUpTemplateError({ ...configured, template_language: 'fr_FR' }, templates)).toContain('not approved');
        expect(followUpTemplateError({ ...configured, template_parameters: [''] }, templates)).toContain('Fill all');
    });
    it('validates media headers without appending a free-form attachment outside the window', () => {
        const [body] = getFollowUpTemplates([{ ...raw, components: [{ type: 'BODY', text: 'Update' }] }]);
        const configured = { ...step, template_name: 'reminder', media_type: 'image' as const, media_url: 'https://example.com/photo.jpg' };
        expect(followUpTemplateError(configured, [body])).toContain('matching media header');
        const [image] = getFollowUpTemplates([{ ...raw, components: [{ type: 'BODY', text: 'Update' }, { type: 'HEADER', format: 'IMAGE' }] }]);
        expect(followUpTemplateError(configured, [image])).toBeNull();
        expect(followUpTemplateError({ ...configured, media_url: null }, [image])).toContain('requires an image');
    });
});
