export type SendError = { contactId: string; error: string };

export type SendErrorCategory =
    | 'utility_permission_missing'
    | 'utility_template_missing'
    | 'recipient_unavailable'
    | 'outside_messaging_window'
    | 'thread_controlled_by_another_app'
    | 'invalid_utility_parameter'
    | 'rate_limited'
    | 'authentication_required'
    | 'transient'
    | 'other';

type StructuredSendError = Error & {
    status?: number;
    code?: number;
    subcode?: number;
    requiresReauth?: boolean;
};

function getStructuredSendError(error: unknown): StructuredSendError | null {
    return error instanceof Error ? error as StructuredSendError : null;
}

function getSendErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error || '');
}

export function categorizeSendError(error: unknown): SendErrorCategory {
    const structured = getStructuredSendError(error);
    const normalized = getSendErrorMessage(error).trim().toLowerCase();

    if (
        structured?.subcode === 2018300 ||
        normalized.includes('another app is controlling this thread') ||
        normalized.includes('another app controls this thread')
    ) {
        return 'thread_controlled_by_another_app';
    }

    if (
        structured?.subcode === 1893043 ||
        (normalized.includes('special characters') && normalized.includes('not allowed in template parameter')) ||
        normalized.includes('unsupported utility template parameter')
    ) {
        return 'invalid_utility_parameter';
    }

    if (
        structured?.requiresReauth ||
        structured?.code === 190 ||
        normalized.includes('facebook authorization expired') ||
        normalized.includes('access token has expired') ||
        normalized.includes('invalid oauth access token')
    ) {
        return 'authentication_required';
    }

    if (
        structured?.status === 429 ||
        [4, 17, 32, 341, 613].includes(structured?.code || 0) ||
        normalized.includes('(#613)') ||
        normalized.includes('rate limit') ||
        normalized.includes('too many calls')
    ) {
        return 'rate_limited';
    }

    if (
        normalized.includes('pages_utility_messaging') ||
        normalized.includes('requires pages_utility_messaging permission')
    ) {
        return 'utility_permission_missing';
    }

    if (
        normalized.includes('template cannot be found') ||
        normalized.includes('missing utility template') ||
        normalized.includes('utility template not found') ||
        normalized.includes('utility template not ready') ||
        normalized.includes('no approved utility templates') ||
        normalized.includes('template exists but status is') ||
        normalized.includes('is not sendable') ||
        normalized.includes('status is rejected')
    ) {
        return 'utility_template_missing';
    }

    if (
        normalized.includes('(#551)') ||
        normalized.includes("isn't available right now") ||
        normalized.includes('is not available right now')
    ) {
        return 'recipient_unavailable';
    }

    if (
        normalized.includes('(#10)') ||
        normalized.includes('outside the allowed window') ||
        normalized.includes('policy-overview') ||
        normalized.includes('error_subcode: 2018278')
    ) {
        return 'outside_messaging_window';
    }

    if (
        (typeof structured?.status === 'number' && structured.status >= 500) ||
        [1, 2].includes(structured?.code || 0) ||
        normalized.includes('fetch failed') ||
        normalized.includes('network') ||
        normalized.includes('timed out') ||
        normalized.includes('timeout') ||
        normalized.includes('temporarily unavailable') ||
        normalized.includes('try again') ||
        normalized.includes('server error') ||
        normalized.includes('econnreset') ||
        normalized.includes('socket hang up')
    ) {
        return 'transient';
    }

    return 'other';
}

export function isRetryableSendError(error: unknown): boolean {
    const category = categorizeSendError(error);
    return category === 'rate_limited' || category === 'transient';
}

/**
 * Errors that apply to the page, template, or Facebook service must pause a
 * campaign instead of permanently consuming every remaining recipient.
 * Thread ownership is conversation-specific: after automatic takeover fails,
 * only that recipient should fail so one externally controlled thread cannot
 * stop a bulk send for every other contact.
 */
export function shouldPauseCampaignForSendError(error: unknown): boolean {
    const category = categorizeSendError(error);
    return (
        category === 'utility_permission_missing' ||
        category === 'utility_template_missing' ||
        category === 'invalid_utility_parameter' ||
        category === 'rate_limited' ||
        category === 'authentication_required' ||
        category === 'transient'
    );
}

const FORBIDDEN_UTILITY_PARAMETER_LITERAL_PATTERN = /[#%$\uFFFD]/u;
const UTILITY_PARAMETER_EMOJI_PATTERN = /[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D]/u;

/**
 * Meta rejects these characters in Messenger utility-template body values.
 * Validate locally so a bad message cannot consume a campaign audience.
 */
export function getUtilityTemplateParameterValidationError(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0) return null;

    const problems: string[] = [];
    if (FORBIDDEN_UTILITY_PARAMETER_LITERAL_PATTERN.test(value)) {
        problems.push("the characters #, %, $, or an invalid replacement character");
    }
    if (UTILITY_PARAMETER_EMOJI_PATTERN.test(value)) {
        problems.push('emoji');
    }

    return problems.length > 0
        ? `Unsupported utility template parameter: remove ${problems.join(' and ')} before sending.`
        : null;
}

export function summarizeSendErrors(errors: SendError[]): {
    utilityPermissionMissing: number;
    utilityTemplateMissing: number;
    recipientUnavailable: number;
    outsideMessagingWindow: number;
    rateLimited: number;
    authenticationRequired: number;
    transient: number;
    other: number;
} {
    const summary = {
        utilityPermissionMissing: 0,
        utilityTemplateMissing: 0,
        recipientUnavailable: 0,
        outsideMessagingWindow: 0,
        rateLimited: 0,
        authenticationRequired: 0,
        transient: 0,
        other: 0
    };

    for (const entry of errors) {
        const category = categorizeSendError(entry.error);
        if (category === 'utility_permission_missing') {
            summary.utilityPermissionMissing += 1;
        } else if (category === 'utility_template_missing') {
            summary.utilityTemplateMissing += 1;
        } else if (category === 'recipient_unavailable') {
            summary.recipientUnavailable += 1;
        } else if (category === 'outside_messaging_window') {
            summary.outsideMessagingWindow += 1;
        } else if (category === 'rate_limited') {
            summary.rateLimited += 1;
        } else if (category === 'authentication_required') {
            summary.authenticationRequired += 1;
        } else if (category === 'transient') {
            summary.transient += 1;
        } else {
            summary.other += 1;
        }
    }

    return summary;
}

export function mergeSendErrors(
    errorGroups: Array<SendError[] | undefined | null>
): SendError[] {
    const byContactId = new Map<string, SendError>();

    for (const group of errorGroups) {
        if (!group?.length) continue;
        for (const entry of group) {
            const contactId = entry?.contactId?.trim();
            if (!contactId) continue;
            const error = entry?.error?.trim() || 'Unknown error';
            if (byContactId.has(contactId)) {
                byContactId.delete(contactId);
            }
            byContactId.set(contactId, { contactId, error });
        }
    }

    return Array.from(byContactId.values());
}
