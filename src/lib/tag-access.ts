import { AccessError } from './account-security';
import { getSupabaseAdmin } from './supabase';
import { chunkArray } from './chunking';
import { SUPABASE_IN_FILTER_BATCH_SIZE } from './supabase-pagination';

type ScopedTag = { id?: string; owner_type?: string; owner_id?: string; page_id?: string | null;
    is_shared?: boolean; tag_shares?: { shared_with_user_id: string }[] };

export function canReadPageTag(tag: ScopedTag, userId: string, pageId: string): boolean {
    if (tag.owner_type === 'page') return tag.owner_id === pageId && (!tag.page_id || tag.page_id === pageId);
    if (tag.page_id !== pageId) return false;
    if (tag.owner_type === 'business') return true; // Explicit Page binding, not business-wide membership.
    if (tag.owner_type !== 'user') return false;
    if (tag.owner_id === userId) return true;
    return Boolean(tag.is_shared && (!tag.tag_shares?.length || tag.tag_shares.some(share => share.shared_with_user_id === userId)));
}

export async function assertReadableTagIds(db: ReturnType<typeof getSupabaseAdmin>, userId: string, pageId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return;
    const readable = new Set<string>();
    for (const batch of chunkArray(unique, SUPABASE_IN_FILTER_BATCH_SIZE)) {
        const { data, error } = await db.from('tags').select('id,owner_type,owner_id,page_id,is_shared,tag_shares(shared_with_user_id)').in('id', batch);
        if (error) throw error;
        for (const tag of data || []) if (canReadPageTag(tag, userId, pageId)) readable.add(tag.id);
    }
    if (unique.some(id => !readable.has(id))) throw new AccessError(403, 'One or more tags are unavailable for this Page.');
}
