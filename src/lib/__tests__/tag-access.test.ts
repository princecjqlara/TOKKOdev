import { describe, expect, it } from 'vitest';
import { canReadPageTag } from '../tag-access';

describe('assigned Page tag policy', () => {
    it('allows pre-existing Page tags regardless of their creator', () => {
        expect(canReadPageTag({ owner_type: 'page', owner_id: 'manawari', page_id: 'manawari' }, 'new-member', 'manawari')).toBe(true);
    });
    it('denies mismatched Page ownership and business-wide tags', () => {
        expect(canReadPageTag({ owner_type: 'page', owner_id: 'loki', page_id: 'manawari' }, 'member', 'manawari')).toBe(false);
        expect(canReadPageTag({ owner_type: 'business', owner_id: 'business', page_id: null }, 'member', 'manawari')).toBe(false);
        expect(canReadPageTag({ owner_type: 'business', owner_id: 'business', page_id: 'manawari' }, 'member', 'manawari')).toBe(true);
    });
    it('preserves personal-tag privacy and explicit share targets', () => {
        const tag = { owner_type: 'user', owner_id: 'creator', page_id: 'manawari' };
        expect(canReadPageTag(tag, 'member', 'manawari')).toBe(false);
        expect(canReadPageTag(tag, 'creator', 'manawari')).toBe(true);
        expect(canReadPageTag({ ...tag, is_shared: true }, 'member', 'manawari')).toBe(true);
        expect(canReadPageTag({ ...tag, is_shared: true, tag_shares: [{ shared_with_user_id: 'someone-else' }] }, 'member', 'manawari')).toBe(false);
        expect(canReadPageTag({ ...tag, is_shared: true, tag_shares: [{ shared_with_user_id: 'member' }] }, 'member', 'loki')).toBe(false);
    });
});
