const PLACEHOLDER_NAME_VALUES = new Set([
    'unknown',
    'unknown name',
    'unknown user',
    'facebook user',
    'undefined',
    'null'
]);

export function normalizeContactName(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }

    if (PLACEHOLDER_NAME_VALUES.has(trimmed.toLowerCase())) {
        return null;
    }

    return trimmed;
}

export function hasUsableContactName(value: unknown): value is string {
    return normalizeContactName(value) !== null;
}

export function pickPreferredContactName(...candidates: unknown[]): string | null {
    for (const candidate of candidates) {
        const normalized = normalizeContactName(candidate);
        if (normalized) {
            return normalized;
        }
    }

    return null;
}

export function composeContactName(firstName: unknown, lastName: unknown): string | null {
    const first = typeof firstName === 'string' ? firstName.trim() : '';
    const last = typeof lastName === 'string' ? lastName.trim() : '';
    return normalizeContactName([first, last].filter(Boolean).join(' '));
}
