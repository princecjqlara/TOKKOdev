import { ContactRecord } from '@/lib/placeholders';

export type RequestedMessageButton = {
    type?: string;
    text: string;
    url?: string;
    payload?: string;
};

export type ButtonMode = 'TEMPLATE_STATIC' | 'RESPONSE_DYNAMIC';

type NormalizedTemplateButton = {
    type: 'URL' | 'QUICK_REPLY';
    text: string;
    value: string;
};

const URL_SCHEME_REGEX = /^[a-z][a-z\d+\-.]*:/i;

export function resolveButtonMode(rawMode: unknown): ButtonMode {
    if (typeof rawMode !== 'string') {
        return 'TEMPLATE_STATIC';
    }

    return rawMode.trim().toUpperCase() === 'RESPONSE_DYNAMIC'
        ? 'RESPONSE_DYNAMIC'
        : 'TEMPLATE_STATIC';
}

export type ResolvedMessageParts = {
    part1: string;
    part2: string;
    combined: string;
    isTwoPart: boolean;
};

function normalizeSupportTeamPageName(pageName: string): string {
    return pageName.trim().replace(/\s+/g, ' ') || 'Page';
}

export function buildSupportTeamTemplateBodyCandidates(pageName: string): string[] {
    const normalizedPageName = normalizeSupportTeamPageName(pageName);
    const candidates = [
        `{{1}} - from ${normalizedPageName} support team - {{2}}`,
        `{{1}} - update from ${normalizedPageName} support team - {{2}}`,
        `{{1}} - message from ${normalizedPageName} support team - {{2}}`,
        `{{1}} - ${normalizedPageName} support team update - {{2}}`
    ];

    return Array.from(new Set(candidates));
}

export function buildUtilityTemplateBodyCandidates(
    pageName: string,
    requiresSupportTeamTemplate: boolean,
    allowSinglePlaceholderOption = false
): string[] {
    if (requiresSupportTeamTemplate) {
        const supportTeamCandidates = buildSupportTeamTemplateBodyCandidates(pageName);
        if (allowSinglePlaceholderOption) {
            return ['{{1}}', ...supportTeamCandidates];
        }

        return supportTeamCandidates;
    }

    return ['{{1}}'];
}

export function buildUtilityTemplateBodyExample(bodyText: string): string[][] | undefined {
    const placeholderMatches = Array.from(bodyText.matchAll(/\{\{(\d+)\}\}/g));
    if (placeholderMatches.length === 0) {
        return undefined;
    }

    const uniquePlaceholderCount = new Set(placeholderMatches.map((match) => match[1])).size;
    const exampleValues = [
        'Your account update is ready.',
        'Please review the latest details.',
        'Tap below for more information.'
    ];

    const values = Array.from({ length: uniquePlaceholderCount }, (_, index) => {
        return exampleValues[index] || `Sample value ${index + 1}`;
    });

    return [values];
}

export function buildSupportTeamTemplateBody(pageName: string): string {
    return buildSupportTeamTemplateBodyCandidates(pageName)[0];
}

function normalizeTemplateButtonType(type: unknown): 'URL' | 'QUICK_REPLY' | null {
    if (typeof type !== 'string') {
        return null;
    }

    const normalizedType = type.trim().toUpperCase();
    if (normalizedType === 'URL' || normalizedType === 'WEB_URL') {
        return 'URL';
    }

    if (normalizedType === 'POSTBACK' || normalizedType === 'QUICK_REPLY') {
        return 'QUICK_REPLY';
    }

    return null;
}

function normalizeButtonCandidate(button: RequestedMessageButton | Record<string, unknown>): NormalizedTemplateButton | null {
    const type = normalizeTemplateButtonType(button.type);
    const text = typeof button.text === 'string' ? button.text.trim() : '';

    if (!type || !text) {
        return null;
    }

    if (type === 'URL') {
        const value = normalizeUrlButtonValue(button.url);
        if (!value) {
            return null;
        }

        return { type, text, value };
    }

    const payload =
        typeof button.payload === 'string' && button.payload.trim().length > 0
            ? button.payload.trim()
            : text;

    return { type, text, value: payload };
}

export function applyDynamicButtonValue(
    buttons: RequestedMessageButton[],
    dynamicValue: string
): RequestedMessageButton[] {
    if (!Array.isArray(buttons) || buttons.length === 0) {
        return [];
    }

    const updatedButtons = buttons.map((button) => ({ ...button }));
    const firstButton = updatedButtons[0];
    if (!firstButton) {
        return updatedButtons;
    }

    const normalizedDynamicValue = dynamicValue.trim();
    if (!normalizedDynamicValue) {
        return updatedButtons;
    }

    const buttonType = normalizeTemplateButtonType(firstButton.type);
    if (buttonType === 'URL') {
        const normalizedUrl = normalizeUrlButtonValue(normalizedDynamicValue);
        if (normalizedUrl) {
            firstButton.url = normalizedUrl;
            return updatedButtons;
        }

        firstButton.text = normalizedDynamicValue;
        return updatedButtons;
    }

    firstButton.text = normalizedDynamicValue;
    firstButton.payload = normalizedDynamicValue;
    return updatedButtons;
}

function normalizeUrlButtonValue(rawUrl: unknown): string | null {
    if (typeof rawUrl !== 'string') {
        return null;
    }

    const trimmed = rawUrl.trim();
    if (!trimmed) {
        return null;
    }

    const withScheme = URL_SCHEME_REGEX.test(trimmed) ? trimmed : `https://${trimmed}`;

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(withScheme);
    } catch {
        return null;
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return null;
    }

    const hostname = parsedUrl.hostname.trim().toLowerCase();
    if (!hostname) {
        return null;
    }

    if (hostname !== 'localhost' && !hostname.includes('.')) {
        return null;
    }

    return parsedUrl.toString();
}

function extractTemplateButtons(template: Record<string, unknown>): {
    rawCount: number;
    normalizedButtons: NormalizedTemplateButton[];
} {
    const components = template.components;
    if (!Array.isArray(components)) {
        return { rawCount: 0, normalizedButtons: [] };
    }

    const buttonComponents = components.filter((component) => {
        if (!component || typeof component !== 'object') return false;
        const componentType = (component as Record<string, unknown>).type;
        return typeof componentType === 'string' && componentType.trim().toUpperCase() === 'BUTTONS';
    }) as Record<string, unknown>[];

    if (buttonComponents.length === 0) {
        return { rawCount: 0, normalizedButtons: [] };
    }

    const rawButtons = buttonComponents.flatMap((buttonComponent) => {
        if (!Array.isArray(buttonComponent.buttons)) {
            return [];
        }

        return buttonComponent.buttons;
    });

    const normalizedButtons = rawButtons
        .map((button) => {
            if (!button || typeof button !== 'object') {
                return null;
            }

            return normalizeButtonCandidate(button as Record<string, unknown>);
        })
        .filter((button): button is NormalizedTemplateButton => button !== null);

    return {
        rawCount: rawButtons.length,
        normalizedButtons
    };
}

export function normalizeRequestedButtons(buttons?: RequestedMessageButton[]): NormalizedTemplateButton[] {
    if (!Array.isArray(buttons) || buttons.length === 0) {
        return [];
    }

    return buttons
        .map((button) => normalizeButtonCandidate(button))
        .filter((button): button is NormalizedTemplateButton => button !== null);
}

export function toRequestedButtons(buttons: NormalizedTemplateButton[]): RequestedMessageButton[] {
    return buttons.map((button) => {
        if (button.type === 'URL') {
            return {
                type: 'URL',
                text: button.text,
                url: button.value
            };
        }

        return {
            type: 'QUICK_REPLY',
            text: button.text,
            payload: button.value
        };
    });
}

export function resolveMessageParts(
    rawMessageText?: string,
    rawPart1?: string,
    rawPart2?: string
): ResolvedMessageParts {
    const hasExplicitPart1 = typeof rawPart1 === 'string';
    const hasExplicitPart2 = typeof rawPart2 === 'string';

    if (hasExplicitPart1 || hasExplicitPart2) {
        const part1 = hasExplicitPart1 ? rawPart1 || '' : '';
        const part2 = hasExplicitPart2 ? rawPart2 || '' : '';
        return {
            part1,
            part2,
            combined: `${part1}|||${part2}`,
            isTwoPart: part2.trim().length > 0
        };
    }

    const source = typeof rawMessageText === 'string' ? rawMessageText : '';
    const separatorIndex = source.indexOf('|||');
    if (separatorIndex === -1) {
        return {
            part1: source,
            part2: '',
            combined: `${source}|||`,
            isTwoPart: false
        };
    }

    const part1 = source.slice(0, separatorIndex);
    const part2 = source.slice(separatorIndex + 3);
    return {
        part1,
        part2,
        combined: `${part1}|||${part2}`,
        isTwoPart: part2.trim().length > 0
    };
}

export function templateMatchesRequestedButtons(
    template: Record<string, unknown>,
    requestedButtons?: RequestedMessageButton[]
): boolean {
    const expectedButtons = normalizeRequestedButtons(requestedButtons);
    const { rawCount, normalizedButtons } = extractTemplateButtons(template);

    if (rawCount !== expectedButtons.length) {
        return false;
    }

    if (normalizedButtons.length !== rawCount) {
        return false;
    }

    return expectedButtons.every((expectedButton, index) => {
        const templateButton = normalizedButtons[index];
        if (!templateButton) {
            return false;
        }

        return (
            expectedButton.type === templateButton.type &&
            expectedButton.text === templateButton.text &&
            expectedButton.value === templateButton.value
        );
    });
}

export function buildUtilityBodyParameters(
    placeholderCount: number,
    message: string,
    contact: Pick<ContactRecord, 'id' | 'name'>,
    templateBodyText: string,
    singlePlaceholderSeparator?: string
): string[] {
    if (placeholderCount <= 0) {
        return [];
    }

    const parts = message.split('|||');
    const part1 = parts[0] || '';
    const part2 = parts[1] || '';
    const isTwoPartMessage = part2.trim().length > 0;

    const firstName = contact.name?.trim().split(/\s+/)[0] || 'there';
    const contactReference = contact.id.replace(/-/g, '').slice(0, 8) || '00000000';
    const normalizedBodyText = templateBodyText.toLowerCase().replace(/\s+/g, ' ').trim();
    const isSupportTeamBody = /support\s*team/.test(normalizedBodyText);
    const looksLikeOrderTemplate =
        normalizedBodyText.includes('order') ||
        normalizedBodyText.includes('delivery') ||
        normalizedBodyText.includes('tracking');

    if (placeholderCount === 1) {
        if (isTwoPartMessage && typeof singlePlaceholderSeparator === 'string') {
            return [`${part1}${singlePlaceholderSeparator}${part2}`];
        }

        return [part1];
    }

    if (placeholderCount === 2) {
        if (isTwoPartMessage || isSupportTeamBody) {
            return [part1, part2];
        }

        if (templateBodyText.includes('{{1}}') && templateBodyText.includes('{{2}}')) {
            return [firstName, part1];
        }
        return [part1, part2];
    }

    const parameters = [firstName];
    parameters.push(looksLikeOrderTemplate ? contactReference : part1);

    for (let i = 2; i < placeholderCount; i += 1) {
        parameters.push(part1);
    }

    return parameters;
}
