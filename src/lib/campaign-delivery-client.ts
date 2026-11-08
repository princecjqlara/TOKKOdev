import { requestWithTimeout } from './request-timeout';

export type CampaignDeliveryResponse = {
    success?: boolean;
    partial?: boolean;
    paused?: boolean;
    cancelled?: boolean;
    queued?: boolean;
    retryable?: boolean;
    sent?: number;
    failed?: number;
    remaining?: number;
    processed?: number;
    nextAttemptAt?: string | null;
    message?: string;
};

export const CAMPAIGN_DELIVERY_REQUEST_TIMEOUT_MS = 90_000;
const RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 60_000;

/** Keep driving the saved queue through temporary failures and Page cooldowns. */
export async function runCampaignDelivery(
    campaignId: string,
    options: {
        payload?: Record<string, unknown>;
        initial?: CampaignDeliveryResponse;
        expectedUpdatedAt?: string;
        signal?: AbortSignal;
        onProgress?: (progress: CampaignDeliveryResponse) => void;
    } = {}
): Promise<CampaignDeliveryResponse> {
    let progress: CampaignDeliveryResponse = { ...options.initial };
    let backgroundOnly = options.initial?.queued === true;
    let failures = 0;
    let delayMs = 0;
    const abortError = () => options.signal?.reason || new DOMException('Campaign delivery stopped.', 'AbortError');

    for (;;) {
        if (options.signal?.aborted) throw abortError();
        if (delayMs > 0) await new Promise<void>((resolve, reject) => {
            const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); };
            const cancel = () => { cleanup(); reject(abortError()); };
            const timer = setTimeout(() => { cleanup(); resolve(); }, delayMs);
            options.signal?.addEventListener('abort', cancel, { once: true });
            if (options.signal?.aborted) cancel();
        });
        try {
            const { response, data } = await requestWithTimeout(async signal => {
                const response = await fetch(`/api/campaigns/${campaignId}/send`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal,
                    body: JSON.stringify({
                        ...options.payload,
                        backgroundOnly,
                        expectedUpdatedAt: options.expectedUpdatedAt
                    })
                });
                // Gateway timeouts can have an HTML body. Successful responses
                // must contain a delivery result before they can finish a run.
                const data = await response.json().catch(() => null) as CampaignDeliveryResponse | null;
                return { response, data };
            }, CAMPAIGN_DELIVERY_REQUEST_TIMEOUT_MS, 'Campaign delivery request timed out.', options.signal);

            if (data?.queued === true || data?.partial === true) backgroundOnly = true;
            const temporary = data?.retryable !== false && (data?.retryable === true || response.status === 408 ||
                response.status === 429 || response.status >= 500 || response.ok && typeof data?.success !== 'boolean');
            if (!temporary && (!response.ok || !data || typeof data !== 'object' || typeof data.success !== 'boolean')) {
                throw Object.assign(new Error(data?.message || `Campaign delivery failed (HTTP ${response.status}).`), { permanent: true });
            }

            if (data && typeof data === 'object') progress = {
                ...progress, partial: false, paused: false, cancelled: false,
                queued: false, retryable: false, nextAttemptAt: null, ...data
            };
            if (!temporary && !data?.queued && (progress.cancelled || progress.paused || progress.partial !== true || progress.remaining === 0)) {
                // A final result must not inherit retry/partial flags from an
                // earlier slice whose response did not include terminal fields.
                progress = { ...progress, partial: false, queued: false, retryable: false };
                options.onProgress?.(progress);
                return progress;
            }

            if (temporary || data?.queued) {
                failures++;
                delayMs = Math.min(MAX_RETRY_DELAY_MS, RETRY_DELAY_MS * 2 ** Math.min(failures - 1, 5));
                const retryAt = Date.parse(data?.nextAttemptAt || '');
                if (Number.isFinite(retryAt)) delayMs = Math.max(delayMs, retryAt - Date.now());
                progress = { ...progress, retryable: true, message: data?.message || 'Delivery is temporarily unavailable. Retrying automatically.' };
            } else {
                backgroundOnly = true;
                failures = 0;
                // An empty claim can mean another worker owns the remaining
                // recipients. Poll patiently instead of ending or busy looping.
                delayMs = data?.processed === 0 ? RETRY_DELAY_MS : 0;
                progress = { ...progress, queued: false, retryable: false, paused: false };
            }
            options.onProgress?.(progress);
        } catch (error) {
            if (options.signal?.aborted) throw abortError();
            if ((error as { permanent?: boolean })?.permanent) throw error;
            failures++;
            delayMs = Math.min(MAX_RETRY_DELAY_MS, RETRY_DELAY_MS * 2 ** Math.min(failures - 1, 5));
            options.onProgress?.({ ...progress, retryable: true, message: 'Connection interrupted. Resuming automatically.' });
        }
    }
}
