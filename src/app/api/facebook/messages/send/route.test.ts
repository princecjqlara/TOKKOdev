import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/get-session', () => ({
    getSessionFromRequest: vi.fn()
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: vi.fn()
}));

vi.mock('@/lib/facebook', () => ({
    createUtilityTemplate: vi.fn(),
    getPageTemplates: vi.fn(),
    sendMessage: vi.fn()
}));

vi.mock('@/lib/chunking', () => ({
    chunkArray: vi.fn()
}));

vi.mock('@/lib/placeholders', () => ({
    replaceTemplateVariablesForParts: vi.fn()
}));

import {
    buildUtilityBodyParameters,
    templateMatchesRequestedButtons
} from './route';

describe('buildUtilityBodyParameters', () => {
    it('keeps support-team separator between message parts', () => {
        const parameters = buildUtilityBodyParameters(
            2,
            'Ready to increase your real estate sales!|||huwag ka nna mag pahuli you\'re one click away!',
            { id: 'contact-1234', name: 'Prince Doe' },
            '{{1}} - Message from Ares Media support team - {{2}}'
        );

        expect(parameters).toEqual([
            'Ready to increase your real estate sales!',
            'huwag ka nna mag pahuli you\'re one click away!'
        ]);
    });

    it('keeps first-name substitution for one-part non support-team templates', () => {
        const parameters = buildUtilityBodyParameters(
            2,
            'Your appointment is confirmed',
            { id: 'contact-1234', name: 'Prince Doe' },
            '{{1}}, your update: {{2}}'
        );

        expect(parameters).toEqual(['Prince', 'Your appointment is confirmed']);
    });

    it('keeps part1 and part2 order for two-part messages even on generic two-slot templates', () => {
        const parameters = buildUtilityBodyParameters(
            2,
            'Huy! Kikim still interested?|||Don\'t worry there are 5 lots left',
            { id: 'contact-1234', name: 'Prince Doe' },
            '{{1}}, your update: {{2}}'
        );

        expect(parameters).toEqual(['Huy! Kikim still interested?', 'Don\'t worry there are 5 lots left']);
    });
});

describe('templateMatchesRequestedButtons', () => {
    it('rejects a template with stale URL button values', () => {
        const template = {
            components: [
                { type: 'BODY', text: '{{1}} - Message from Ares Media support team - {{2}}' },
                {
                    type: 'BUTTONS',
                    buttons: [
                        { type: 'URL', text: 'Click here', url: 'https://old.example.com/join' }
                    ]
                }
            ]
        };

        const requestedButtons = [
            { type: 'URL', text: 'Click here', url: 'https://instantmeeting.vercel.app/join/aresmedia' }
        ];

        expect(templateMatchesRequestedButtons(template, requestedButtons)).toBe(false);
    });

    it('rejects templates with buttons when none are requested', () => {
        const template = {
            components: [
                { type: 'BODY', text: '{{1}}' },
                {
                    type: 'BUTTONS',
                    buttons: [
                        { type: 'URL', text: 'Click here', url: 'https://example.com' }
                    ]
                }
            ]
        };

        expect(templateMatchesRequestedButtons(template, undefined)).toBe(false);
    });

    it('matches equivalent quick reply and postback button payloads', () => {
        const template = {
            components: [
                { type: 'BODY', text: '{{1}}' },
                {
                    type: 'BUTTONS',
                    buttons: [
                        { type: 'POSTBACK', text: 'Talk to sales', payload: 'talk_sales' }
                    ]
                }
            ]
        };

        const requestedButtons = [
            { type: 'QUICK_REPLY', text: 'Talk to sales', payload: 'talk_sales' }
        ];

        expect(templateMatchesRequestedButtons(template, requestedButtons)).toBe(true);
    });
});
