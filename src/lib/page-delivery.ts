import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from './supabase';
import { databaseRequest } from './database-request';
export const MAX_PAGE_DELIVERY_CONCURRENCY = 100;

export function waitForPageDeliveryBatch(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function reportPageDeliveryFeedback(supabase: ReturnType<typeof getSupabaseAdmin>, pageId: string, owner: string,
    state?: { concurrency: number; intervalMs: number; limited: boolean; providerRetryAt: number; scope: 'page' | 'app' }) {
    const { data, error } = await databaseRequest(supabase.rpc('report_page_campaign_delivery_feedback', {
        p_page_id: pageId, p_owner: owner,
        p_concurrency: state?.concurrency ?? null, p_interval_ms: state?.intervalMs ?? null,
        p_rate_limited: state?.limited ?? false,
        p_retry_after_ms: state ? Math.ceil(Math.max(0, state.providerRetryAt - Date.now())) : 0,
        p_scope: state?.scope || 'page'
    }));
    if (error) throw error;
    if (!data?.owned) throw new Error('Page delivery lease changed. Delivery will retry automatically.');
    if (!Number.isInteger(data.concurrency) || data.concurrency < 1 || data.concurrency > MAX_PAGE_DELIVERY_CONCURRENCY ||
        !Number.isInteger(data.interval_ms) || data.interval_ms < 0 || data.interval_ms > 5000) {
        throw new Error('Page delivery feedback is temporarily unavailable.');
    }
    const growthAfter = data.growth_after == null ? 0 : Date.parse(data.growth_after);
    if (!Number.isFinite(growthAfter)) throw new Error('Page recovery pace is temporarily unavailable.');
    return { concurrency: Number(data.concurrency), intervalMs: Number(data.interval_ms),
        retryAt: data.retry_at as string | null, growthAfter };
}

export async function acquirePageDelivery(supabase: ReturnType<typeof getSupabaseAdmin>, pageId: string) {
    const owner = randomUUID();
    const { data, error } = await databaseRequest(supabase.rpc('acquire_page_campaign_delivery', { p_page_id: pageId, p_owner: owner }));
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.acquired !== 'boolean') throw new Error('Page delivery coordination returned an invalid response');
    return { owner, acquired: row.acquired, retryAt: row.retry_at as string | null, batchSize: Math.max(1, Math.min(MAX_PAGE_DELIVERY_CONCURRENCY, Number(row.batch_size) || 1)) };
}

export async function releasePageDelivery(supabase: ReturnType<typeof getSupabaseAdmin>, pageId: string, owner: string, rateLimited: boolean) {
    const { data, error } = await databaseRequest(supabase.rpc('release_page_campaign_delivery', {
        p_page_id: pageId, p_owner: owner, p_rate_limited: rateLimited
    }));
    if (error) throw error;
    return data as string | null;
}
