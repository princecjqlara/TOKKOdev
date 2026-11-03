import { AccessError } from './account-security';

export const ACCOUNT_REQUEST_TIMEOUT_MS = 8_000;

/** Bound auth queries so a stalled database cannot leave session checks pending. */
export async function accountRequest<T>(request: PromiseLike<T> & {
    abortSignal?: (signal: AbortSignal) => PromiseLike<T>;
}): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                reject(new AccessError(503, 'Sign-in is temporarily unavailable.'));
                controller.abort();
            }, ACCOUNT_REQUEST_TIMEOUT_MS);
        });
        return await Promise.race([
            request.abortSignal ? request.abortSignal(controller.signal) : request,
            deadline
        ]);
    } finally {
        clearTimeout(timer);
    }
}
