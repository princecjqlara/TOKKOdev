import { describe, expect, it } from 'vitest';
import { isVerifiedCandidate, isBlockingReviewError, parseReviewBatch, reviewWithCooldown } from '../../../scripts/template-review.mjs';
import { vi } from 'vitest';

const candidate = { name: 'short_casual_order_g1_e1_v1', components: [{ type: 'BODY', text: 'Hey! Order update: {{1}}.' }] };
const approved = { ...candidate, language: 'en_US', category: 'UTILITY', status: 'APPROVED' };

describe('approval promotion', () => {
    it('requires a live approval for the exact name, body, language, category, and component structure', () => {
        expect(isVerifiedCandidate(candidate, approved)).toBe(true);
        expect(isVerifiedCandidate(candidate, { ...approved, language: { code: 'en_US' }, status: 'ACTIVE' })).toBe(true);
        for (const change of [
            { status: 'PENDING' }, { status: 'REJECTED' }, { status: 'ALREADY_EXISTS' },
            { category: 'MARKETING' }, { language: 'es_ES' }, { name: 'another_template' },
            { components: [{ type: 'BODY', text: 'Different {{1}}' }] },
            { components: [...candidate.components, { type: 'HEADER', format: 'IMAGE' }] },
            { components: [] }
        ]) expect(isVerifiedCandidate(candidate, { ...approved, ...change })).toBe(false);
    });
});

describe('rate-limit recovery', () => {
    it('waits and retries only rate-limited entries while retaining completed decisions', async () => {
        const candidates = [candidate, { ...candidate, name: 'second' }, { ...candidate, name: 'third' }];
        const send = vi.fn()
            .mockResolvedValueOnce([
                { name: candidate.name, status: 'APPROVED' },
                { name: 'second', status: 'ERROR', code: 80001 },
                { name: 'third', status: 'REJECTED' }
            ])
            .mockResolvedValueOnce([{ name: 'second', status: 'ERROR', code: 80001 }])
            .mockResolvedValueOnce([{ name: 'second', status: 'APPROVED' }]);
        const wait = vi.fn().mockResolvedValue(undefined);
        const result = await reviewWithCooldown(candidates, send, wait);
        expect(result.map((entry: { status: string }) => entry.status)).toEqual(['APPROVED', 'APPROVED', 'REJECTED']);
        expect(send.mock.calls.map(call => call[0].map((entry: { name: string }) => entry.name))).toEqual([
            candidates.map(entry => entry.name), ['second'], ['second']
        ]);
        expect(wait.mock.calls.map(call => call[0])).toEqual([60000, 120000]);
    });

    it('recovers from a rate-limited outer batch response but surfaces permission failures', async () => {
        const send = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error('Too many calls'), { code: 80001 }))
            .mockResolvedValueOnce([{ name: candidate.name, status: 'APPROVED' }]);
        const wait = vi.fn().mockResolvedValue(undefined);
        expect(await reviewWithCooldown([candidate], send, wait)).toEqual([{ name: candidate.name, status: 'APPROVED' }]);
        await expect(reviewWithCooldown([candidate], vi.fn().mockRejectedValue(Object.assign(new Error('Invalid token'), { code: 190 })), wait)).rejects.toThrow('Invalid token');
    });
});

describe('bulk review responses', () => {
    it('keeps approvals, pending reviews, rejections, and request errors distinct', () => {
        const candidates = [candidate, { ...candidate, name: 'pending' }, { ...candidate, name: 'rejected' }, { ...candidate, name: 'rate_limited' }];
        const results = parseReviewBatch(candidates, [
            { code: 200, body: JSON.stringify({ id: '1', status: 'APPROVED' }) },
            { code: 200, body: JSON.stringify({ id: '2' }) },
            { code: 200, body: JSON.stringify({ id: '3', status: 'REJECTED' }) },
            { code: 429, body: JSON.stringify({ error: { code: 613, message: 'Rate limit' } }) }
        ]);
        expect(results.map((result: { status: string }) => result.status)).toEqual(['APPROVED', 'PENDING', 'REJECTED', 'ERROR']);
        expect(results[3]).toMatchObject({ name: 'rate_limited', error: 'Rate limit', code: 613 });
    });

    it('does not silently skip missing batch responses', () => {
        expect(() => parseReviewBatch([candidate], [])).toThrow('incomplete');
        expect(() => parseReviewBatch([candidate], {})).toThrow('incomplete');
    });

    it('records a candidate-specific validation refusal separately from service failures', () => {
        expect(parseReviewBatch([candidate], [{ code: 400, body: JSON.stringify({ error: {
            code: 100, error_subcode: 2388047, message: 'Invalid parameter', error_user_msg: 'Invalid template wording'
        } }) }])[0]).toMatchObject({ name: candidate.name, status: 'INVALID', code: 100, details: 'Invalid template wording' });
    });

    it('stops for rate or permission errors while retaining individual server failures for later retry', () => {
        expect(isBlockingReviewError({ status: 'ERROR', code: 613 })).toBe(true);
        expect(isBlockingReviewError({ status: 'ERROR', code: 190 })).toBe(true);
        expect(isBlockingReviewError({ status: 'ERROR', code: 200 })).toBe(true);
        expect(isBlockingReviewError({ status: 'ERROR', code: -1 })).toBe(false);
        expect(isBlockingReviewError({ status: 'ERROR', code: 960 })).toBe(false);
        expect(isBlockingReviewError({ status: 'REJECTED' })).toBe(false);
    });
});
