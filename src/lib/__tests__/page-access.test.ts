import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getSupabaseAdmin: vi.fn()
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

import { getUserPageIds, userHasPageAccess } from '@/lib/page-access';

function queryBuilder(result: { data: unknown; error: unknown }) {
    const builder: Record<string, any> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.maybeSingle = vi.fn().mockResolvedValue(result);
    builder.then = (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve);
    return builder;
}

describe('Page access helpers', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns all unique Page memberships for export listing', async () => {
        const builder = queryBuilder({
            data: [{ page_id: 'page_1' }, { page_id: 'page_2' }, { page_id: 'page_1' }],
            error: null
        });
        mocks.getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => builder) });

        await expect(getUserPageIds('user_1')).resolves.toEqual(['page_1', 'page_2']);
        expect(builder.eq).toHaveBeenCalledWith('user_id', 'user_1');
    });

    it('checks both the user and Page before granting access', async () => {
        const builder = queryBuilder({ data: { page_id: 'page_1' }, error: null });
        mocks.getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => builder) });

        await expect(userHasPageAccess('user_2', 'page_1')).resolves.toBe(true);
        expect(builder.eq).toHaveBeenNthCalledWith(1, 'user_id', 'user_2');
        expect(builder.eq).toHaveBeenNthCalledWith(2, 'page_id', 'page_1');
    });
});
