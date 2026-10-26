import type { Campaign } from '@/types';

type DeliverySlice = {
    partial?: unknown;
    paused?: unknown;
    cancelled?: unknown;
    queued?: unknown;
    retryable?: unknown;
    remaining?: unknown;
    processed?: unknown;
    nextAttemptAt?: unknown;
};

// Both bulk-send screens must yield to the durable worker when delivery is
// deferred. In particular, an HTTP 200 queued response is not another slice.
export function shouldContinueCampaignDelivery(slice: DeliverySlice, now = Date.now()): boolean {
    return Boolean(slice.partial) && Number(slice.remaining) > 0 &&
        !slice.paused && !slice.cancelled && !slice.queued && !slice.retryable &&
        !(typeof slice.nextAttemptAt === 'string' && Date.parse(slice.nextAttemptAt) > now);
}

export function getCampaignDeliveryState(campaign: Pick<Campaign,
    'status' | 'is_loop' | 'background_delivery_enabled' | 'next_attempt_at' | 'last_error' | 'scheduled_at'
> & { use_best_time?: boolean }, now = Date.now()) {
    if (campaign.status !== 'sending' && campaign.status !== 'scheduled') return campaign.status;
    if (campaign.status === 'sending' && !campaign.is_loop && !campaign.use_best_time && !campaign.scheduled_at &&
        campaign.background_delivery_enabled === false) return 'paused';
    if (campaign.next_attempt_at && Date.parse(campaign.next_attempt_at) > now) {
        return /rate limit|too many calls|\(#613\)/i.test(campaign.last_error || '')
            ? 'rate_limited' : 'retrying';
    }
    return campaign.status;
}
