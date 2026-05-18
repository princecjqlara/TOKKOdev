import { describe, expect, it } from 'vitest';
import {
    getCampaignMessagePreview,
    normalizeCampaignMessageParts,
    parseCampaignMessageSequence,
    serializeCampaignMessageSequence
} from '../campaign-message-sequence';

describe('campaign message sequences', () => {
    it('normalizes blank and non-string parts', () => {
        expect(normalizeCampaignMessageParts([' first ', '', 12, 'second'])).toEqual(['first', 'second']);
    });

    it('keeps single messages backward compatible', () => {
        const serialized = serializeCampaignMessageSequence(['Only one']);

        expect(serialized).toBe('Only one');
        expect(parseCampaignMessageSequence(serialized)).toEqual(['Only one']);
    });

    it('round-trips multiple ordered messages', () => {
        const serialized = serializeCampaignMessageSequence(['Send this', 'Then this', 'Then this too']);

        expect(parseCampaignMessageSequence(serialized)).toEqual(['Send this', 'Then this', 'Then this too']);
        expect(getCampaignMessagePreview(serialized)).toBe('1. Send this / 2. Then this / 3. Then this too');
    });
});
