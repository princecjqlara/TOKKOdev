import { describe, expect, it } from 'vitest';
import { buildNotInFilter } from '../tag-filters';

describe('buildNotInFilter', () => {
    it('returns null for empty input', () => {
        expect(buildNotInFilter([])).toBeNull();
    });

    it('quotes values for PostgREST in filter syntax', () => {
        expect(buildNotInFilter(['a', 'b'])).toBe("('a','b')");
    });

    it('escapes embedded single quotes', () => {
        expect(buildNotInFilter(["a'b"])).toBe("('a''b')");
    });
});
