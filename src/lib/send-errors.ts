export type SendError = { contactId: string; error: string };

export type SendErrorCategory =
    | 'utility_permission_missing'
    | 'utility_template_missing'
    | 'recipient_unavailable'
    | 'other';

export function categorizeSendError(error: string): SendErrorCategory {
    const normalized = error.trim().toLowerCase();

    if (
        normalized.includes('pages_utility_messaging') ||
        normalized.includes('requires pages_utility_messaging permission')
    ) {
        return 'utility_permission_missing';
    }

    if (
        normalized.includes('template cannot be found') ||
        normalized.includes('missing utility template') ||
        normalized.includes('utility template not found')
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

    return 'other';
}

export function isRetryableSendError(error: string): boolean {
    const category = categorizeSendError(error);
    return category === 'other';
}

export function summarizeSendErrors(errors: SendError[]): {
    utilityPermissionMissing: number;
    utilityTemplateMissing: number;
    recipientUnavailable: number;
    other: number;
} {
    const summary = {
        utilityPermissionMissing: 0,
        utilityTemplateMissing: 0,
        recipientUnavailable: 0,
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
