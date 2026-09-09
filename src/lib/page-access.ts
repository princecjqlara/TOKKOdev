import { getSupabaseAdmin } from '@/lib/supabase';

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
