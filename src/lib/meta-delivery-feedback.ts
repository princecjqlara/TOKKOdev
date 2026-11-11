export type MetaQuotaScope = 'page' | 'app' | 'user' | 'business';
export type MetaDeliveryFeedback = {
    usagePercent?: number;
    retryAfterMs?: number;
    scope?: MetaQuotaScope;
    scopeKey?: string;
    retryScope?: MetaQuotaScope;
    retryScopeKey?: string;
    businessKeys?: string[];
};

/** Error codes identify the throttled quota; a usage header may describe a
 * different quota. Unknown user ownership is kept local to the Page token. */
export function getMetaThrottleScope(feedback?: MetaDeliveryFeedback & { code?: number }): MetaQuotaScope {
    if (feedback?.code === 4) return 'app';
    if (feedback?.code === 17) return 'user';
    if (feedback?.code === 32) return 'page';
    if (feedback?.code === 613 && feedback.retryScope !== 'business' && feedback.scope !== 'business') return 'page';
    return feedback?.retryScope || feedback?.scope || 'page';
}

export function getMetaThrottleKey(feedback?: MetaDeliveryFeedback): string | undefined {
    return feedback?.retryScope === 'business' ? feedback.retryScopeKey : feedback?.scopeKey;
}

/** Read only quota fields; never retain headers containing credentials. */
export function readMetaDeliveryFeedback(headers?: Pick<Headers, 'get'>, now = Date.now()): MetaDeliveryFeedback | undefined {
    if (!headers?.get) return undefined;
    const feedback: MetaDeliveryFeedback = {};
    let recoveryScope: MetaQuotaScope | undefined;
    let recoveryKey: string | undefined;
    const businessKeys = new Set<string>();
    const retry = headers.get('retry-after');
    if (retry) {
        const seconds = Number(retry);
        const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - now;
        if (Number.isFinite(milliseconds) && milliseconds > 0) {
            feedback.retryAfterMs = Math.min(milliseconds, 24 * 60 * 60_000);
            // Retry-After applies to this request. A separate app-usage
            // percentage does not prove its delay belongs to every Page.
            recoveryScope = 'page';
        }
    }
    for (const name of ['x-app-usage', 'x-page-usage', 'x-business-use-case-usage']) {
        const raw = headers.get(name);
        if (!raw || raw.length > 100_000) continue;
        try {
            const visit = (value: unknown, depth = 0, objectId?: string) => {
                if (!value || typeof value !== 'object' || depth > 5) return;
                const record = value as Record<string, unknown>;
                let quotaKey: string | undefined;
                if (name === 'x-business-use-case-usage' && typeof record.type === 'string') {
                    if (!['messenger', 'pages'].includes(record.type)) return;
                    if (objectId && /^\d+$/.test(objectId)) {
                        quotaKey = `${objectId}:${record.type}`;
                        businessKeys.add(quotaKey);
                    }
                }
                for (const [key, item] of Object.entries(value)) {
                    if (['call_count', 'total_cputime', 'total_time'].includes(key) && typeof item === 'number' && Number.isFinite(item) && item >= 0) {
                        if (feedback.usagePercent === undefined || item > feedback.usagePercent ||
                            item === feedback.usagePercent && name === 'x-app-usage') {
                            feedback.usagePercent = item;
                            feedback.scope = quotaKey ? 'business' : name === 'x-app-usage' ? 'app' : 'page';
                            if (quotaKey) feedback.scopeKey = quotaKey;
                            else delete feedback.scopeKey;
                        }
                    } else if (key === 'estimated_time_to_regain_access' && typeof item === 'number' && Number.isFinite(item) && item > 0) {
                        const recoveryMs = Math.min(item * 60_000, 24 * 60 * 60_000);
                        if (recoveryMs >= (feedback.retryAfterMs || 0)) {
                            feedback.retryAfterMs = recoveryMs;
                            recoveryScope = quotaKey ? 'business' : name === 'x-app-usage' ? 'app' : 'page';
                            recoveryKey = quotaKey;
                        }
                    } else visit(item, depth + 1, /^\d+$/.test(key) && !Array.isArray(value) ? key : objectId);
                }
            };
            visit(JSON.parse(raw));
        } catch { /* Some responses omit or contain malformed optional quota headers. */ }
    }
    // Preserve the source of the recovery estimate independently from the
    // highest usage percentage across app and business-use-case headers.
    if (recoveryScope && feedback.scope && (recoveryScope !== feedback.scope || recoveryKey !== feedback.scopeKey)) {
        feedback.retryScope = recoveryScope;
        if (recoveryKey) feedback.retryScopeKey = recoveryKey;
    }
    if (businessKeys.size) feedback.businessKeys = [...businessKeys].sort();
    return Object.keys(feedback).length ? feedback : undefined;
}
