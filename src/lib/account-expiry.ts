export function accountHasExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
    if (expiresAt == null) return false;
    const expiry = Date.parse(expiresAt);
    return !Number.isFinite(expiry) || expiry <= now;
}

/** Omitted preserves an existing expiry; null explicitly removes it. */
export function parseAccountExpiry(value: unknown): string | null | undefined {
    if (value === undefined || value === null) return value;
    // Require an explicit timezone so client and server interpret the same instant.
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
        || accountHasExpired(value)) throw new Error('Choose a valid expiry date and time in the future.');
    return new Date(value).toISOString();
}
