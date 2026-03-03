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

import { buildUtilityBodyParameters } from './route';

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

    it('keeps first-name substitution for non support-team templates', () => {
        const parameters = buildUtilityBodyParameters(
            2,
            'Your appointment is confirmed|||See you soon',
            { id: 'contact-1234', name: 'Prince Doe' },
            '{{1}}, your update: {{2}}'
        );

        expect(parameters).toEqual(['Prince', 'Your appointment is confirmed']);
    });
});
