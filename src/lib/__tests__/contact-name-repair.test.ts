import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repairMissingContactNamesForPage } from '../contact-name-repair';

const mocks = vi.hoisted(() => ({
    getConversationIdForPsid: vi.fn(),
    getConversationMessages: vi.fn(),
    getUserProfile: vi.fn()
}));

vi.mock('../facebook', () => ({
    getConversationIdForPsid: mocks.getConversationIdForPsid,
    getConversationMessages: mocks.getConversationMessages,
    getUserProfile: mocks.getUserProfile
}));

function createSupabaseMock(options: {
    nullNameContacts?: Array<{ id: string; psid: string | null; name: string | null }>;
    placeholderContacts?: Array<{ id: string; psid: string | null; name: string | null }>;
}) {
    const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];

    const createSelectBuilder = () => {
        const state = {
            placeholderQuery: false
        };

        type SelectBuilder = {
            eq: any;
            not: any;
            neq: any;
            is: any;
            in: any;
            order: any;
            range: any;
        };

        const builder = {} as SelectBuilder;
        builder.eq = vi.fn(() => builder);
        builder.not = vi.fn(() => builder);
        builder.neq = vi.fn(() => builder);
        builder.is = vi.fn(() => builder);
        builder.in = vi.fn(() => {
            state.placeholderQuery = true;
            return builder;
        });
        builder.order = vi.fn(() => builder);
        builder.range = vi.fn(async () => ({
            data: state.placeholderQuery
                ? options.placeholderContacts || []
                : options.nullNameContacts || [],
            error: null
        }));

        return builder;
    };

    const contactsTable = {
        select: vi.fn(() => createSelectBuilder()),
        update: vi.fn((payload: Record<string, unknown>) => ({
            eq: vi.fn(async (_column: string, id: string) => {
                updates.push({ id, payload });
                return { error: null };
            })
        }))
    };

    return {
        updates,
        from: vi.fn((table: string) => {
            if (table !== 'contacts') {
                throw new Error(`Unexpected table ${table}`);
            }

            return contactsTable;
        })
    };
}

const page = {
    id: 'page_1',
    fb_page_id: 'fb_page_1',
    access_token: 'page_access_token_1'
};

describe('repairMissingContactNamesForPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('repairs old unnamed contacts from Facebook profile names', async () => {
        const supabase = createSupabaseMock({
            nullNameContacts: [{ id: 'contact_1', psid: 'psid_1', name: null }]
        });
        mocks.getUserProfile.mockResolvedValue({
            id: 'psid_1',
            name: 'Jane Profile',
            profile_pic: 'https://example.com/jane.jpg'
        });

        const result = await repairMissingContactNamesForPage(supabase, page);

        expect(result).toEqual({
            checked: 1,
            repaired: 1,
            cleared: 0,
            failed: 0
        });
        expect(supabase.updates[0]).toEqual({
            id: 'contact_1',
            payload: expect.objectContaining({
                name: 'Jane Profile',
                profile_pic: 'https://example.com/jane.jpg'
            })
        });
    });

    it('uses conversation message sender names when profile names are placeholders', async () => {
        const supabase = createSupabaseMock({
            nullNameContacts: [{ id: 'contact_1', psid: 'psid_1', name: null }]
        });
        mocks.getUserProfile.mockResolvedValue({
            id: 'psid_1',
            name: 'Messenger Contact'
        });
        mocks.getConversationIdForPsid.mockResolvedValue('conversation_1');
        mocks.getConversationMessages.mockResolvedValue([
            {
                id: 'message_1',
                message: 'hello',
                from: { id: 'psid_1', name: 'Real Sender Name' },
                created_time: '2026-04-07T02:00:00.000Z'
            }
        ]);

        const result = await repairMissingContactNamesForPage(supabase, page);

        expect(result.repaired).toBe(1);
        expect(mocks.getConversationIdForPsid).toHaveBeenCalledWith(
            'fb_page_1',
            'psid_1',
            'page_access_token_1'
        );
        expect(supabase.updates[0].payload).toEqual(expect.objectContaining({
            name: 'Real Sender Name'
        }));
    });

    it('clears old placeholder names when Facebook returns no real name', async () => {
        const supabase = createSupabaseMock({
            nullNameContacts: [],
            placeholderContacts: [{ id: 'contact_1', psid: 'psid_1', name: 'MESSENGER CONTACT' }]
        });
        mocks.getUserProfile.mockResolvedValue({
            id: 'psid_1',
            name: 'Messenger Contact'
        });
        mocks.getConversationIdForPsid.mockResolvedValue(null);

        const result = await repairMissingContactNamesForPage(supabase, page);

        expect(result.cleared).toBe(1);
        expect(supabase.updates[0].payload).toEqual(expect.objectContaining({
            name: null
        }));
    });
});
