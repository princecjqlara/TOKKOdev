export function accountHasExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
    if (expiresAt == null) return false;
    const expiry = Date.parse(expiresAt);
    return !Number.isFinite(expiry) || expiry <= now;
}

/** Omitted preserves an existing expiry; null explicitly removes it. */
export function parseAccountExpiry(value: unknown): string | null | undefined {
    if (value === undefined || value === null) return value;
    // Require an explicit timezone so client and server interpret the same instant.
    if (typeof value !== 'string') throw new Error('Choose a valid expiry date and time in the future.');
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) throw new Error('Choose a valid expiry date and time in the future.');
    // Date.parse rolls dates such as February 31 and 24:00 into another day.
    // Validate the entered calendar before applying its explicit timezone.
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
    const calendar = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day
        || hour > 23 || minute > 59 || second > 59 || accountHasExpired(value)) {
        throw new Error('Choose a valid expiry date and time in the future.');
    }
    return new Date(value).toISOString();
}
