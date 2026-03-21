import { describe, expect, it, vi } from 'vitest';
import { resolveCampaignAudienceContactIds } from '../campaign-audience';

function createSupabaseMock(options?: {
    includeContactIds?: string[];
    excludeContactIds?: string[];
    contacts?: Array<{ id: string }>;
}) {
    const contactsData = options?.contacts ?? [
        { id: 'contact_1' },
        { id: 'contact_2' }
    ];

    const contactsThen = vi.fn((resolve: (value: { data: Array<{ id: string }>; error: null }) => void) => {
        resolve({
            data: contactsData,
            error: null
        });
        return Promise.resolve();
    });
    const contactsQuery = {
        eq: vi.fn(() => contactsQuery),
        in: vi.fn(() => contactsQuery),
        not: vi.fn(() => contactsQuery),
        neq: vi.fn(() => contactsQuery),
        or: vi.fn(() => contactsQuery),
        then: contactsThen
    };
    const contactsSelect = vi.fn(() => contactsQuery);

    const contactTagsEq = vi.fn()
        .mockResolvedValueOnce({
            data: (options?.includeContactIds ?? ['contact_1', 'contact_2']).map((contact_id) => ({ contact_id })),
            error: null
        })
        .mockResolvedValueOnce({
            data: (options?.excludeContactIds ?? ['contact_2']).map((contact_id) => ({ contact_id })),
            error: null
        });
    const contactTagsIn = vi.fn().mockReturnValue({ eq: contactTagsEq });
    const contactTagsSelect = vi.fn().mockReturnValue({ in: contactTagsIn });

    const from = vi.fn((table: string) => {
        if (table === 'contacts') {
            return {
                select: contactsSelect
            };
        }

        if (table === 'contact_tags') {
            return {
                select: contactTagsSelect
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        contactsBuilder: contactsQuery,
        contactTagsIn,
        contactTagsEq
    };
}

describe('resolveCampaignAudienceContactIds', () => {
    it('applies start-date and sendable filters when resolving a dynamic audience', async () => {
        const supabase = createSupabaseMock();

        const contactIds = await resolveCampaignAudienceContactIds({
            supabase: supabase as never,
            pageId: 'page_1',
            rules: {
                startDate: '2026-03-01'
            }
        });

        expect(contactIds).toEqual(['contact_1', 'contact_2']);
        expect(supabase.contactsBuilder.eq).toHaveBeenCalledWith('page_id', 'page_1');
        expect(supabase.contactsBuilder.not).toHaveBeenCalledWith('psid', 'is', null);
        expect(supabase.contactsBuilder.neq).toHaveBeenCalledWith('psid', '');
        expect(supabase.contactsBuilder.or).toHaveBeenCalledWith(
            'first_interaction_at.gte.2026-03-01,and(first_interaction_at.is.null,created_at.gte.2026-03-01)'
        );
    });

    it('applies include and exclude tag filters before returning contact ids', async () => {
        const supabase = createSupabaseMock({
            includeContactIds: ['contact_1', 'contact_2'],
            excludeContactIds: ['contact_2'],
            contacts: [{ id: 'contact_1' }]
        });

        const contactIds = await resolveCampaignAudienceContactIds({
            supabase: supabase as never,
            pageId: 'page_1',
            rules: {
                includeTagIds: ['tag_a', 'tag_b'],
                excludeTagIds: ['tag_x']
            }
        });

        expect(contactIds).toEqual(['contact_1']);
        expect(supabase.contactTagsIn).toHaveBeenNthCalledWith(1, 'tag_id', ['tag_a', 'tag_b']);
        expect(supabase.contactTagsIn).toHaveBeenNthCalledWith(2, 'tag_id', ['tag_x']);
        expect(supabase.contactTagsEq).toHaveBeenNthCalledWith(1, 'contacts.page_id', 'page_1');
        expect(supabase.contactTagsEq).toHaveBeenNthCalledWith(2, 'contacts.page_id', 'page_1');
        expect(supabase.contactsBuilder.in).toHaveBeenCalledWith('id', ['contact_1', 'contact_2']);
        expect(supabase.contactsBuilder.not).toHaveBeenCalledWith('id', 'in', '("contact_2")');
    });
});
