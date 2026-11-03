import { AccessError } from './account-security';

export const DATABASE_REQUEST_TIMEOUT_MS = 8_000;

class DatabaseTimeoutError extends AccessError {
    readonly code = 'DATABASE_TIMEOUT';
    constructor() { super(503, 'Database service is temporarily unavailable.'); }
}

/** Bound a database operation even when its transport ignores cancellation. */
export async function databaseRequest<T>(request: PromiseLike<T> & {
    abortSignal?: (signal: AbortSignal) => PromiseLike<T>;
}): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                reject(new DatabaseTimeoutError());
                controller.abort();
            }, DATABASE_REQUEST_TIMEOUT_MS);
        });
        return await Promise.race([
            request.abortSignal ? request.abortSignal(controller.signal) : request,
            deadline
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** Log only structured diagnostics; gateway bodies and auth metadata can contain secrets. */
export function databaseErrorDetails(error: unknown, responseStatus?: number) {
    const fields = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    const code = typeof fields.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(fields.code) ? fields.code : null;
    const candidate = responseStatus ?? fields.status;
    const status = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599 ? candidate : null;
    let databaseHost: string | null = null;
    try {
        databaseHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '').hostname;
    } catch { /* Missing or invalid configuration is represented by a null host. */ }

    const message = code === 'DATABASE_TIMEOUT' ? 'Database request timed out.'
        : code === 'PGRST116' ? 'Expected one database record; the lookup returned none or multiple records.'
        : status && status >= 500 ? `Database service is unavailable (HTTP ${status}).`
        : status === 401 || status === 403 ? `Database rejected the server credentials or permissions (HTTP ${status}).`
        : code ? `Database request failed (${code}).`
        : status ? `Database request failed (HTTP ${status}).`
        : 'Database request failed without structured error details.';
    return { error: message, code, status, databaseHost };
}
