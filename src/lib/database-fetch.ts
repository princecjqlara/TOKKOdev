const SERVICE_BACKOFF_MS = 30_000;
const QUOTA_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;

function retryAfterMs(response: Response): number {
    const value = response.headers.get('retry-after');
    if (!value) return 0;
    const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
    return Number.isFinite(delay) ? Math.max(0, Math.min(delay, 24 * 60 * 60_000)) : 0;
}

/** Cool down a warm worker after a REST quota/outage failure, without replaying writes. */
export function createDatabaseFetch(baseUrl: string, transport: typeof fetch = fetch): typeof fetch {
    const origin = new URL(baseUrl).origin;
    let blockedUntil = 0;
    let failures = 0;
    let generation = 0;
    let probing = false;

    function backOff(minimum: number, serverDelay = 0) {
        failures = Math.min(failures + 1, 5);
        const delay = Math.max(minimum, serverDelay, Math.min(MAX_BACKOFF_MS, SERVICE_BACKOFF_MS * 2 ** (failures - 1)));
        blockedUntil = Math.max(blockedUntil, Date.now() + delay);
        generation++;
    }

    return async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin);
        // Storage uploads and other services keep their own request behavior.
        if (url.origin !== origin || !url.pathname.startsWith('/rest/v1/')) return transport(input, init);

        if (Date.now() < blockedUntil || probing) {
            return new Response(JSON.stringify({
                code: 'DATABASE_BACKOFF', message: 'Database requests are cooling down after a service or usage-limit failure.', details: null, hint: null
            }), { status: 503, headers: {
                'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                'Retry-After': String(Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000)))
            } });
        }

        const recoveryProbe = blockedUntil !== 0;
        const startedGeneration = generation;
        if (recoveryProbe) probing = true;
        try {
            const response = await transport(input, init);
            if (response.status === 402 || response.status === 429 || response.status >= 500) {
                backOff(response.status === 402 ? QUOTA_BACKOFF_MS : SERVICE_BACKOFF_MS, retryAfterMs(response));
            } else if (recoveryProbe && startedGeneration === generation) {
                // A reachable service ends the cooldown. Query/permission errors
                // stay with their caller and never become a shared cached success.
                blockedUntil = 0;
                failures = 0;
            }
            return response;
        } catch (error) {
            const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
            if (!signal?.aborted || signal.reason?.code === 'DATABASE_TIMEOUT') backOff(SERVICE_BACKOFF_MS);
            throw error;
        } finally {
            if (recoveryProbe) probing = false;
        }
    };
}
