import {
    getConversationForPsid,
    getUserProfile
} from './facebook';
import {
    composeContactName,
    normalizeContactName,
    pickPreferredContactName,
    PLACEHOLDER_CONTACT_NAME_VALUES
} from './contact-names';

type SupabaseClientLike = {
    from: (table: string) => any;
};

type PageForNameRepair = {
    id: string;
    fb_page_id: string;
    access_token: string;
};

type ContactForNameRepair = {
    id: string;
    psid: string | null;
    name: string | null;
};

export type ContactNameRepairResult = {
    checked: number;
    repaired: number;
    cleared: number;
    failed: number;
};

const DEFAULT_REPAIR_LIMIT = 200;
const NAME_REPAIR_CONCURRENCY = 5;
const NAME_LOOKUP_TIMEOUT_MS = 2000;

function uniqContacts(contacts: ContactForNameRepair[]): ContactForNameRepair[] {
    const byId = new Map<string, ContactForNameRepair>();

    for (const contact of contacts) {
        if (!contact?.id || byId.has(contact.id)) {
            continue;
        }
        byId.set(contact.id, contact);
    }

    return Array.from(byId.values());
}

async function fetchRepairCandidates(
    supabase: SupabaseClientLike,
    pageId: string,
    limit: number
): Promise<ContactForNameRepair[]> {
    const candidates: ContactForNameRepair[] = [];

    const nullNameResult = await supabase
        .from('contacts')
        .select('id, psid, name')
        .eq('page_id', pageId)
        .not('psid', 'is', null)
        .neq('psid', '')
        .is('name', null)
        .order('updated_at', { ascending: true })
        .range(0, limit - 1);

    if (nullNameResult.error) {
        throw nullNameResult.error;
    }

    candidates.push(...(nullNameResult.data || []));

    if (candidates.length < limit) {
        const placeholderNames = [
            ...PLACEHOLDER_CONTACT_NAME_VALUES,
            ...PLACEHOLDER_CONTACT_NAME_VALUES.map((name) => name.toUpperCase()),
            ...PLACEHOLDER_CONTACT_NAME_VALUES.map((name) =>
                name.replace(/\b\w/g, (char) => char.toUpperCase())
            )
        ];

        const placeholderResult = await supabase
            .from('contacts')
            .select('id, psid, name')
            .eq('page_id', pageId)
            .not('psid', 'is', null)
            .neq('psid', '')
            .in('name', [...new Set(placeholderNames)])
            .order('updated_at', { ascending: true })
            .range(0, limit - candidates.length - 1);

        if (placeholderResult.error) {
            throw placeholderResult.error;
        }

        candidates.push(...(placeholderResult.data || []));
    }

    return uniqContacts(candidates).slice(0, limit);
}

async function resolveContactName(
    page: PageForNameRepair,
    contact: ContactForNameRepair
): Promise<{ name: string | null; profilePic: string | null }> {
    if (!contact.psid) {
        return { name: null, profilePic: null };
    }

    let profileName: string | null = null;
    let profilePic: string | null = null;

    try {
        const profile = await getUserProfile(contact.psid, page.access_token, {
            timeoutMs: NAME_LOOKUP_TIMEOUT_MS
        });
        profileName = pickPreferredContactName(
            profile.name,
            composeContactName(profile.first_name, profile.last_name)
        );
        profilePic =
            typeof profile.profile_pic === 'string' && profile.profile_pic.trim().length > 0
                ? profile.profile_pic.trim()
                : null;
    } catch {
        // Profile access can fail for privacy/permission reasons; try message sender names next.
    }

    if (profileName) {
        return { name: profileName, profilePic };
    }

    try {
        const conversation = await getConversationForPsid(
            page.fb_page_id,
            contact.psid,
            page.access_token,
            { throwOnError: true, timeoutMs: NAME_LOOKUP_TIMEOUT_MS }
        );

        if (!conversation) {
            return { name: null, profilePic };
        }

        const messageName = pickPreferredContactName(
            ...(conversation.participants?.data || [])
                .filter((participant) => participant.id === contact.psid)
                .map((participant) => participant.name),
            ...(conversation.messages?.data || [])
                .filter((message) => message.from?.id === contact.psid)
                .map((message) => message.from?.name)
        );

        return {
            name: messageName,
            profilePic
        };
    } catch {
        return { name: null, profilePic };
    }
}

export async function repairMissingContactNamesForPage(
    supabase: SupabaseClientLike,
    page: PageForNameRepair,
    options: { limit?: number } = {}
): Promise<ContactNameRepairResult> {
    const limit = options.limit || DEFAULT_REPAIR_LIMIT;
    const contacts = await fetchRepairCandidates(supabase, page.id, limit);
    const result: ContactNameRepairResult = {
        checked: contacts.length,
        repaired: 0,
        cleared: 0,
        failed: 0
    };

    let nextIndex = 0;

    async function worker() {
        while (nextIndex < contacts.length) {
            const contact = contacts[nextIndex++];
            try {
                const resolved = await resolveContactName(page, contact);
                const normalizedExistingName = normalizeContactName(contact.name);

                if (resolved.name) {
                    const payload: Record<string, unknown> = {
                        name: resolved.name,
                        updated_at: new Date().toISOString()
                    };

                    if (resolved.profilePic) {
                        payload.profile_pic = resolved.profilePic;
                    }

                    const { error } = await supabase
                        .from('contacts')
                        .update(payload)
                        .eq('id', contact.id);

                    if (error) throw error;
                    result.repaired += 1;
                } else if (!normalizedExistingName && contact.name !== null) {
                    const { error } = await supabase
                        .from('contacts')
                        .update({
                            name: null,
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', contact.id);

                    if (error) throw error;
                    result.cleared += 1;
                }
            } catch {
                result.failed += 1;
            }
        }
    }

    await Promise.all(Array.from(
        { length: Math.min(NAME_REPAIR_CONCURRENCY, contacts.length) },
        () => worker()
    ));

    return result;
}
