import { describe, expect, it } from 'vitest';
import { getCampaignDeliveryState, shouldContinueCampaignDelivery } from '../campaign-delivery-state';

describe('campaign delivery recovery', () => {
    const now = Date.parse('2026-10-26T08:00:00Z');
    const slice = { partial: true, remaining: 2303, processed: 5 };
    it.each([
        { queued: true }, { retryable: true }, { paused: true }, { cancelled: true },
        { remaining: 0 }, { nextAttemptAt: '2026-10-26T08:51:00Z' }
    ])('stops browser continuation for a deferred or finished slice: %j', change => {
        expect(shouldContinueCampaignDelivery({ ...slice, ...change }, now)).toBe(false);
    });
    it('continues a successful slice with pending work', () => {
        expect(shouldContinueCampaignDelivery(slice, now)).toBe(true);
    });
    it('starts a newly materialized tracked campaign before any recipients have been processed', () => {
        // The creation endpoint returns processed=0. The screens check for
        // zero progress after a send request, so creation can start delivery.
        expect(shouldContinueCampaignDelivery({ partial: true, processed: 0, remaining: 6000 }, now)).toBe(true);
    });
    it('explains a Meta cooldown until the retry time passes', () => {
        const campaign = { status: 'sending' as const, background_delivery_enabled: true,
            scheduled_at: null, next_attempt_at: '2026-10-26T08:51:00Z', last_error: '(#613) Calls have exceeded the rate limit.' };
        expect(getCampaignDeliveryState(campaign, now)).toBe('rate_limited');
        expect(getCampaignDeliveryState(campaign, now + 60 * 60 * 1000)).toBe('sending');
    });
    it('distinguishes a service retry from a disabled immediate campaign', () => {
        const campaign = { status: 'sending' as const, scheduled_at: null,
            next_attempt_at: '2026-10-26T08:51:00Z', last_error: 'Database unavailable' };
        expect(getCampaignDeliveryState(campaign, now)).toBe('retrying');
        expect(getCampaignDeliveryState({ ...campaign, background_delivery_enabled: false }, now)).toBe('paused');
    });
    it('does not relabel a best-time send or a manually paused draft', () => {
        expect(getCampaignDeliveryState({ status: 'scheduled', scheduled_at: null, background_delivery_enabled: false }, now)).toBe('scheduled');
        expect(getCampaignDeliveryState({ status: 'sending', use_best_time: true, scheduled_at: null, background_delivery_enabled: false }, now)).toBe('sending');
        expect(getCampaignDeliveryState({ status: 'draft', scheduled_at: null, next_attempt_at: '2099-01-01' }, now)).toBe('draft');
    });
});
