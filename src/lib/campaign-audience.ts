import { buildNotInFilter } from './tag-filters';

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

    const { data, error } = await supabase
        .from('contact_tags')
        .select('contact_id, contacts!inner(page_id)')
        .in('tag_id', normalizedTagIds)
        .eq('contacts.page_id', pageId);

    if (error) {
        throw new Error(error.message || 'Failed to resolve tagged contacts');
    }

    return normalizeIds((data || []).map((row: { contact_id?: string | null }) => row.contact_id));
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

    if (includeTagIds.length > 0) {
        const includedContactIds = await getTaggedContactIds(supabase, pageId, includeTagIds);
        if (includedContactIds.length === 0) {
            return [];
        }
        query = query.in('id', includedContactIds);
    }

    if (excludeTagIds.length > 0) {
        const excludedContactIds = await getTaggedContactIds(supabase, pageId, excludeTagIds);
        const notInFilter = buildNotInFilter(excludedContactIds);
        if (notInFilter) {
            query = query.not('id', 'in', notInFilter);
        }
    }

    const { data, error } = await query;
    if (error) {
        throw new Error(error.message || 'Failed to resolve campaign audience');
    }

    return normalizeIds((data || []).map((row: { id?: string | null }) => row.id));
}
