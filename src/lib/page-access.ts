import { getSupabaseAdmin } from '@/lib/supabase';
import { AccessError } from './account-security';
import { chunkArray } from './chunking';
import { SUPABASE_IN_FILTER_BATCH_SIZE } from './supabase-pagination';

export async function assertContactsOnPage(supabase: ReturnType<typeof getSupabaseAdmin>, pageId: string, contactIds: string[]) {
    const ids = [...new Set(contactIds)];
    const found = new Set<string>();
    for (const batch of chunkArray(ids, SUPABASE_IN_FILTER_BATCH_SIZE)) {
        const { data, error } = await supabase.from('contacts').select('id').eq('page_id', pageId).in('id', batch);
        if (error) throw error;
        for (const contact of data || []) found.add(contact.id);
    }
    if (ids.some(id => !found.has(id))) throw new AccessError(403, 'Every selected contact must belong to this Page.');
}

export async function getUserPageIds(userId: string): Promise<string[]> {
    const { data, error } = await getSupabaseAdmin()
        .from('user_pages')
        .select('page_id')
        .eq('user_id', userId);
    if (error) throw error;
    return [...new Set((data || []).map((membership) => membership.page_id))];
}

export async function userHasPageAccess(userId: string, pageId: string): Promise<boolean> {
    const { data, error } = await getSupabaseAdmin()
        .from('user_pages')
        .select('page_id')
        .eq('user_id', userId)
        .eq('page_id', pageId)
        .maybeSingle();
    if (error) throw error;
    return Boolean(data);
}
