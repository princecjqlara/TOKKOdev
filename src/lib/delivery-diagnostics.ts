import { categorizeSendError, getBackendSendErrorCode, type SendErrorCategory } from './send-errors';

export const FAILURE_KINDS = [
    'recipient_unavailable', 'conversation_unavailable', 'messaging_policy',
    'page_configuration', 'rate_limited', 'provider_failure', 'transport_failure',
    'backend_failure', 'unknown'
] as const;
export type FailureKind = typeof FAILURE_KINDS[number];
export type DeliveryDiagnostic = {
    kind: FailureKind;
    category: SendErrorCategory;
    source: 'meta' | 'backend' | 'connection' | 'unknown';
    code?: number;
    subcode?: number;
    httpStatus?: number;
    backendCode?: string;
    /** Binds campaign-level evidence to the saved interruption text. */
    message?: string;
};

export const FAILURE_INFO: Record<FailureKind, { label: string; explanation: string; action: string }> = {
    recipient_unavailable: {
        label: 'Recipient unavailable / possibly blocked',
        explanation: 'Meta cannot message this recipient. They may have blocked the Page, deactivated their account, or become unavailable. Blocking is not confirmed.',
        action: 'Check the conversation in Messenger. Wait for the person to contact your Page again.'
    },
    conversation_unavailable: {
        label: 'Conversation unavailable',
        explanation: 'Meta reports that the conversation was deleted, archived, or no longer exists. This does not confirm blocking.',
        action: 'Check the conversation in Messenger before trying again.'
    },
    messaging_policy: {
        label: 'Messaging window / policy',
        explanation: 'Meta rejected this message under its messaging-window rules.',
        action: 'Use an approved, eligible template or wait for a new customer message.'
    },
    page_configuration: {
        label: 'Page access, template, or setup',
        explanation: 'Page authorization, permissions, thread ownership, template approval, or message settings need attention.',
        action: 'Check the saved error below; reconnect the Page or correct its message settings as needed.'
    },
    rate_limited: {
        label: 'Meta rate limit',
        explanation: 'Meta temporarily limited sending. This is not evidence of blocking.',
        action: 'Allow the automatic cooldown to finish before continuing.'
    },
    provider_failure: {
        label: 'Meta service failure',
        explanation: 'The provider returned a temporary or internal error.',
        action: 'Allow automatic recovery, then check Meta service status if it persists.'
    },
    transport_failure: {
        label: 'Connection / timeout',
        explanation: 'A connection failure or timeout interrupted the request. The available evidence does not identify which service caused it.',
        action: 'Allow automatic recovery. Check service connectivity if the error repeats.'
    },
    backend_failure: {
        label: 'Tokkow backend / database',
        explanation: 'Tokkow encountered an internal processing or database failure. This does not indicate that a client blocked the Page.',
        action: 'Allow recovery or ask an administrator to check the backend logs.'
    },
    unknown: {
        label: 'Unclassified / history unavailable',
        explanation: 'The saved evidence is insufficient to determine the cause.',
        action: 'Review the original error. Older recipient details may have been removed by retention.'
    }
};

export function diagnoseDeliveryError(error: unknown, context: 'send' | 'backend' = 'send'): DeliveryDiagnostic {
    const record = error && typeof error === 'object' ? error as {
        name?: string; message?: string; code?: string | number; subcode?: number; status?: number
    } : {};
    const message = typeof error === 'string' ? error : record.message || '';
    const match = /\(#(-?\d+)\)/.exec(message);
    const subcodeMatch = /error_subcode\s*[:=]\s*(\d+)/i.exec(message);
    const code = typeof record.code === 'number' ? record.code : match ? Number(match[1]) : undefined;
    const subcode = record.subcode ?? (subcodeMatch ? Number(subcodeMatch[1]) : undefined);
    const category = categorizeSendError(error);
    const provider = record.name === 'FacebookGraphApiError' || code !== undefined || subcode !== undefined;
    let kind: FailureKind = 'unknown';
    let source: DeliveryDiagnostic['source'] = provider ? 'meta' : 'unknown';

    if (category === 'backend_failure') {
        kind = 'backend_failure'; source = 'backend';
    } else if (category === 'recipient_unavailable' || category === 'conversation_unavailable') {
        kind = category; source = 'meta';
    } else if (category === 'outside_messaging_window') {
        kind = 'messaging_policy'; source = 'meta';
    } else if (['utility_permission_missing', 'utility_template_missing', 'invalid_utility_parameter',
        'authentication_required', 'permission_missing', 'thread_controlled_by_another_app'].includes(category)) {
        kind = 'page_configuration'; source = 'meta';
    } else if (category === 'rate_limited') {
        kind = 'rate_limited'; source = 'meta';
    } else if (provider && category === 'transient') {
        kind = 'provider_failure';
    } else if (context === 'backend' && !provider) {
        kind = 'backend_failure'; source = 'backend';
    } else if (category === 'transient') {
        kind = 'transport_failure'; source = 'connection';
    }

    return { kind, category, source, ...(code !== undefined ? { code } : {}),
        ...(subcode !== undefined ? { subcode } : {}),
        ...(getBackendSendErrorCode(error) ? { backendCode: getBackendSendErrorCode(error)! } : {}),
        ...(typeof record.status === 'number' ? { httpStatus: record.status } : {}) };
}

export function readDeliveryDiagnostic(value: unknown, fallback?: unknown): DeliveryDiagnostic {
    if (value && typeof value === 'object' && FAILURE_KINDS.includes((value as DeliveryDiagnostic).kind)) {
        return value as DeliveryDiagnostic;
    }
    return diagnoseDeliveryError(fallback);
}

const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;

export function getDeliveryMetrics(campaign: {
    total_recipients: number; sent_count: number; failed_count: number; is_loop?: boolean;
    failure_counts?: Record<string, number> | null;
}) {
    const sent = count(campaign.sent_count), failed = count(campaign.failed_count);
    // Loop counters accumulate attempts across cycles, so an audience size is
    // not a valid denominator for their percentages.
    const total = campaign.is_loop ? sent + failed : Math.max(count(campaign.total_recipients), sent + failed);
    const pending = campaign.is_loop ? 0 : Math.max(0, total - sent - failed);
    const percentage = (value: number) => total > 0 ? value / total * 100 : 0;
    const counts = Object.fromEntries(FAILURE_KINDS.map(kind => [kind, count(campaign.failure_counts?.[kind])])) as Record<FailureKind, number>;
    // Never imply that missing historical classifications mean zero failures.
    // Invalid/inconsistent aggregates are treated as unclassified evidence.
    const classified = Object.values(counts).reduce((sum, value) => sum + value, 0);
    if (classified > failed) FAILURE_KINDS.forEach(kind => { counts[kind] = 0; });
    counts.unknown += Math.max(0, failed - Object.values(counts).reduce((sum, value) => sum + value, 0));
    return { sent, failed, pending, total, sentPercent: percentage(sent), failedPercent: percentage(failed),
        pendingPercent: percentage(pending), counts };
}
