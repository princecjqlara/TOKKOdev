export function buildNotInFilter(_values: string[]): string | null {
    const values = Array.isArray(_values) ? _values : [];
    const sanitized = values
        .map(value => value?.trim())
        .filter((value): value is string => Boolean(value))
        .map(value => {
            const escaped = value
                .replace(/\\/g, '\\\\')
                .replace(/"/g, '\\"');
            return `"${escaped}"`;
        });

    if (sanitized.length === 0) return null;

    return `(${sanitized.join(',')})`;
}
