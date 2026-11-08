/** Refill each slot as it finishes; retain input order without batch barriers. */
export async function mapConcurrentSettled<T, R>(
    items: readonly T[],
    concurrency: number,
    execute: (item: T, index: number) => Promise<R>,
    onSettled?: (result: PromiseSettledResult<R>, index: number) => Promise<void>
): Promise<PromiseSettledResult<R>[]> {
    const results = new Array<PromiseSettledResult<R>>(items.length);
    let next = 0;
    let handlerFailed = false;
    let handlerError: unknown;
    const worker = async () => {
        while (!handlerFailed) {
            const index = next++;
            if (index >= items.length) return;
            let result: PromiseSettledResult<R>;
            try { result = { status: 'fulfilled', value: await execute(items[index], index) }; }
            catch (reason) { result = { status: 'rejected', reason }; }
            results[index] = result;
            try { await onSettled?.(result, index); }
            catch (error) { handlerFailed = true; handlerError = error; }
        }
    };
    const slots = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
    // Drain in-flight work before reporting a persistence failure.
    await Promise.all(Array.from({ length: Math.min(slots, items.length) }, worker));
    if (handlerFailed) throw handlerError;
    return results;
}
