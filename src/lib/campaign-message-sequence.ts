const MESSAGE_SEQUENCE_PREFIX = '__TOKKO_MESSAGE_SEQUENCE_V1__';

export type CampaignMessagePart = {
    text: string;
    templateName?: string | null;
    templateLanguage?: string | null;
};

function normalizeTemplateValue(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeCampaignMessagePartObjects(parts: unknown): CampaignMessagePart[] {
    if (!Array.isArray(parts)) {
        return [];
    }

    return parts
        .map((part): CampaignMessagePart | null => {
            if (typeof part === 'string') {
                const text = part.trim();
                return text ? { text } : null;
            }

            if (!part || typeof part !== 'object') {
                return null;
            }

            const record = part as Record<string, unknown>;
            const text = typeof record.text === 'string'
                ? record.text.trim()
                : typeof record.messageText === 'string'
                    ? record.messageText.trim()
                    : '';

            if (!text) {
                return null;
            }

            return {
                text,
                templateName: normalizeTemplateValue(record.templateName),
                templateLanguage: normalizeTemplateValue(record.templateLanguage)
            };
        })
        .filter((part): part is CampaignMessagePart => part !== null);
}

export function normalizeCampaignMessageParts(parts: unknown): string[] {
    return normalizeCampaignMessagePartObjects(parts).map((part) => part.text);
}

export function serializeCampaignMessageSequence(parts: unknown): string {
    const normalizedParts = normalizeCampaignMessagePartObjects(parts);
    const hasPerPartTemplate = normalizedParts.some((part) => part.templateName || part.templateLanguage);
    const normalized = normalizedParts.map((part) => part.text);
    if (normalized.length <= 1) {
        if (hasPerPartTemplate) {
            return `${MESSAGE_SEQUENCE_PREFIX}${JSON.stringify(normalizedParts)}`;
        }
        return normalizedParts[0]?.text || '';
    }

    return `${MESSAGE_SEQUENCE_PREFIX}${JSON.stringify(
        hasPerPartTemplate ? normalizedParts : normalized
    )}`;
}

export function parseCampaignMessageParts(messageText: string | null | undefined): CampaignMessagePart[] {
    if (!messageText) {
        return [];
    }

    if (!messageText.startsWith(MESSAGE_SEQUENCE_PREFIX)) {
        return [{ text: messageText }];
    }

    try {
        const parsed = JSON.parse(messageText.slice(MESSAGE_SEQUENCE_PREFIX.length));
        return normalizeCampaignMessagePartObjects(parsed);
    } catch {
        return [{ text: messageText }];
    }
}

export function parseCampaignMessageSequence(messageText: string | null | undefined): string[] {
    return parseCampaignMessageParts(messageText).map((part) => part.text);
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
