import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from './supabase';

export function waitForPageDeliveryBatch(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function acquirePageDelivery(supabase: ReturnType<typeof getSupabaseAdmin>, pageId: string) {
    const owner = randomUUID();
    const { data, error } = await supabase.rpc('acquire_page_campaign_delivery', { p_page_id: pageId, p_owner: owner });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.acquired !== 'boolean') throw new Error('Page delivery coordination returned an invalid response');
    return { owner, acquired: row.acquired, retryAt: row.retry_at as string | null, batchSize: Math.max(1, Math.min(10, Number(row.batch_size) || 1)) };
}

export async function releasePageDelivery(supabase: ReturnType<typeof getSupabaseAdmin>, pageId: string, owner: string, rateLimited: boolean) {
    const { data, error } = await supabase.rpc('release_page_campaign_delivery', {
        p_page_id: pageId, p_owner: owner, p_rate_limited: rateLimited
    });
    if (error) throw error;
    return data as string | null;
}
