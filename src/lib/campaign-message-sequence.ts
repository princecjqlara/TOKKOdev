const MESSAGE_SEQUENCE_PREFIX = '__TOKKO_MESSAGE_SEQUENCE_V1__';

export function normalizeCampaignMessageParts(parts: unknown): string[] {
    if (!Array.isArray(parts)) {
        return [];
    }

    return parts
        .filter((part): part is string => typeof part === 'string')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}

export function serializeCampaignMessageSequence(parts: string[]): string {
    const normalized = normalizeCampaignMessageParts(parts);
    if (normalized.length <= 1) {
        return normalized[0] || '';
    }

    return `${MESSAGE_SEQUENCE_PREFIX}${JSON.stringify(normalized)}`;
}

export function parseCampaignMessageSequence(messageText: string | null | undefined): string[] {
    if (!messageText) {
        return [];
    }

    if (!messageText.startsWith(MESSAGE_SEQUENCE_PREFIX)) {
        return [messageText];
    }

    try {
        const parsed = JSON.parse(messageText.slice(MESSAGE_SEQUENCE_PREFIX.length));
        return normalizeCampaignMessageParts(parsed);
    } catch {
        return [messageText];
    }
}

export function getCampaignMessagePreview(messageText: string | null | undefined): string {
    const parts = parseCampaignMessageSequence(messageText);
    if (parts.length === 0) {
        return '';
    }

    if (parts.length === 1) {
        return parts[0];
    }

    return parts.map((part, index) => `${index + 1}. ${part}`).join(' / ');
}
