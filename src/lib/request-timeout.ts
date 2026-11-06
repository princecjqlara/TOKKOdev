/** Bound the complete operation, including response bodies, and cancel its transport. */
export async function requestWithTimeout<T>(
    operation: (signal: AbortSignal) => PromiseLike<T>,
    timeoutMs: number,
    message: string,
    parentSignal?: AbortSignal
): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
        const deadline = new Promise<never>((_, reject) => {
            const cancel = () => {
                const error = new Error(message);
                reject(error);
                controller.abort(error);
            };
            onAbort = cancel;
            if (parentSignal?.aborted) cancel();
            else {
                parentSignal?.addEventListener('abort', cancel, { once: true });
                timer = setTimeout(cancel, timeoutMs);
            }
        });
        return await Promise.race([
            deadline,
            // Do not start another network request after the caller's deadline.
            controller.signal.aborted ? deadline : operation(controller.signal)
        ]);
    } finally {
        clearTimeout(timer);
        if (onAbort) parentSignal?.removeEventListener('abort', onAbort);
    }
}
