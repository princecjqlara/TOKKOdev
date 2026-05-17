import { fetchAllSupabaseRows } from './supabase-pagination';

export interface CampaignAudienceRules {
    startDate?: string | null;
    includeTagIds?: string[];
    excludeTagIds?: string[];
}

interface SupabaseLike {
    from: (table: string) => any;
}

function normalizeIds(values: unknown[] | undefined): string[] {
    return [...new Set((values || [])
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean))];
}

async function getTaggedContactIds(
    supabase: SupabaseLike,
    pageId: string,
    tagIds: string[]
): Promise<string[]> {
    const normalizedTagIds = normalizeIds(tagIds);
    if (normalizedTagIds.length === 0) {
        return [];
    }

    const query = supabase
        .from('contact_tags')
        .select('contact_id, contacts!inner(page_id)')
        .in('tag_id', normalizedTagIds)
        .eq('contacts.page_id', pageId);

    const data = await fetchAllSupabaseRows<{ contact_id?: string | null }>(query);

    return normalizeIds(data.map((row) => row.contact_id));
}

export async function resolveCampaignAudienceContactIds({
    supabase,
    pageId,
    rules,
    sendableOnly = true
}: {
    supabase: SupabaseLike;
    pageId: string;
    rules?: CampaignAudienceRules | null;
    sendableOnly?: boolean;
}): Promise<string[]> {
    const includeTagIds = normalizeIds(rules?.includeTagIds);
    const excludeTagIds = normalizeIds(rules?.excludeTagIds);

    let query = supabase.from('contacts').select('id');
    query = query.eq('page_id', pageId);

    if (sendableOnly) {
        query = query.not('psid', 'is', null);
        query = query.neq('psid', '');
    }

    if (rules?.startDate) {
        query = query.or(
            `first_interaction_at.gte.${rules.startDate},and(first_interaction_at.is.null,created_at.gte.${rules.startDate})`
        );
    }

    const includedContactIdSet = includeTagIds.length > 0
        ? new Set(await getTaggedContactIds(supabase, pageId, includeTagIds))
        : null;
    if (includedContactIdSet && includedContactIdSet.size === 0) {
        return [];
    }

    const excludedContactIdSet = excludeTagIds.length > 0
        ? new Set(await getTaggedContactIds(supabase, pageId, excludeTagIds))
        : null;

    const data = await fetchAllSupabaseRows<{ id?: string | null }>(query);

    return normalizeIds(
        data
            .map((row) => row.id)
            .filter((id): id is string => {
                if (!id) return false;
                if (includedContactIdSet && !includedContactIdSet.has(id)) return false;
                if (excludedContactIdSet && excludedContactIdSet.has(id)) return false;
                return true;
            })
    );
}
