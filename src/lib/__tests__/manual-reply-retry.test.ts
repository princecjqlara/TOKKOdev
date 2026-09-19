import { describe, expect, it } from 'vitest';
import {
    createManualReplyFingerprint,
    getSentPartsForRetry,
    mergeSentParts
} from '@/lib/manual-reply-retry';

describe('manual reply partial-delivery retries', () => {
    const media = {
        name: 'receipt.png',
        size: 1024,
        type: 'image/png',
        lastModified: 12345
    };

    it('remembers a successfully sent media part for the same reply', () => {
        const fingerprint = createManualReplyFingerprint('Thank you', [media]);
        const sentParts = getSentPartsForRetry({ fingerprint, sentParts: ['media:0'] }, fingerprint);

        expect(sentParts.has('media:0')).toBe(true);
        expect(sentParts.has('text')).toBe(false);
    });

    it('does not suppress parts when the reply content changes', () => {
        const originalFingerprint = createManualReplyFingerprint('Thank you', [media]);
        const changedFingerprint = createManualReplyFingerprint('Updated message', [media]);
        const sentParts = getSentPartsForRetry(
            { fingerprint: originalFingerprint, sentParts: ['media:0'] },
            changedFingerprint
        );

        expect([...sentParts]).toEqual([]);
    });

    it('tracks multiple attachments separately, including files of the same type', () => {
        expect(mergeSentParts(['media:0'], ['media:0', 'media:1'])).toEqual(['media:0', 'media:1']);
    });
});
