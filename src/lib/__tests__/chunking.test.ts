import { describe, expect, it } from 'vitest';
import { chunkArray } from '../chunking';

describe('chunkArray', () => {
    it('splits arrays into fixed-size chunks', () => {
        const input = [1, 2, 3, 4, 5];
        expect(chunkArray(input, 2)).toEqual([[1, 2], [3, 4], [5]]);
    });

    it('returns empty array for empty input', () => {
        expect(chunkArray([], 3)).toEqual([]);
    });
});
