export type MetaDeliveryFeedback = {
    usagePercent?: number;
    retryAfterMs?: number;
    scope?: 'page' | 'app';
};

/** Read only quota fields; never retain headers containing credentials. */
export function readMetaDeliveryFeedback(headers?: Pick<Headers, 'get'>, now = Date.now()): MetaDeliveryFeedback | undefined {
    if (!headers?.get) return undefined;
    const feedback: MetaDeliveryFeedback = {};
    const retry = headers.get('retry-after');
    if (retry) {
        const seconds = Number(retry);
        const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - now;
        if (Number.isFinite(milliseconds) && milliseconds > 0) feedback.retryAfterMs = Math.min(milliseconds, 24 * 60 * 60_000);
    }
    for (const name of ['x-app-usage', 'x-page-usage', 'x-business-use-case-usage']) {
        const raw = headers.get(name);
        if (!raw || raw.length > 100_000) continue;
        try {
            const visit = (value: unknown, depth = 0) => {
                if (!value || typeof value !== 'object' || depth > 5) return;
                for (const [key, item] of Object.entries(value)) {
                    if (['call_count', 'total_cputime', 'total_time'].includes(key) && typeof item === 'number' && Number.isFinite(item) && item >= 0) {
                        if (feedback.usagePercent === undefined || item > feedback.usagePercent ||
                            item === feedback.usagePercent && name === 'x-app-usage') {
                            feedback.usagePercent = item;
                            feedback.scope = name === 'x-app-usage' ? 'app' : 'page';
                        }
                    } else if (key === 'estimated_time_to_regain_access' && typeof item === 'number' && Number.isFinite(item) && item > 0) {
                        feedback.retryAfterMs = Math.max(feedback.retryAfterMs || 0, Math.min(item * 60_000, 24 * 60 * 60_000));
                    } else visit(item, depth + 1);
                }
            };
            visit(JSON.parse(raw));
        } catch { /* Some responses omit or contain malformed optional quota headers. */ }
    }
    return Object.keys(feedback).length ? feedback : undefined;
}
