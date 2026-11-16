import { describe, expect, it } from 'vitest';
import { diagnoseDeliveryError, FAILURE_INFO, getDeliveryMetrics, readDeliveryDiagnostic } from '../delivery-diagnostics';
import { categorizeSendError, shouldPauseCampaignForSendError } from '../send-errors';

describe('bulk delivery evidence', () => {
    it('preserves provider codes even when the provider message is vague', () => {
        const diagnostic = diagnoseDeliveryError(Object.assign(new Error('Cannot complete request'),
            { name: 'FacebookGraphApiError', code: 551, subcode: 1545041, status: 400 }));
        expect(diagnostic).toEqual({ kind: 'recipient_unavailable', category: 'recipient_unavailable',
            source: 'meta', code: 551, subcode: 1545041, httpStatus: 400 });
        expect(FAILURE_INFO[diagnostic.kind].explanation).toContain('Blocking is not confirmed');
    });

    it('separates permission errors from messaging windows and recipient issues', () => {
        expect(categorizeSendError({ code: 10, message: 'Permission denied' })).toBe('permission_missing');
        expect(shouldPauseCampaignForSendError({ code: 200, message: 'Permissions error' })).toBe(true);
        expect(diagnoseDeliveryError({ code: 10, subcode: 2018278, message: 'Not allowed' }).kind).toBe('messaging_policy');
        expect(diagnoseDeliveryError({ code: 10, subcode: 2018300, message: 'Not allowed' }).kind).toBe('page_configuration');
    });

    it('distinguishes Meta errors, backend errors, ambiguous connections, and unknown errors', () => {
        expect(diagnoseDeliveryError({ code: 2, status: 500, message: 'Server error' }).kind).toBe('provider_failure');
        expect(diagnoseDeliveryError({ code: 'PGRST000', message: 'Database unavailable' }, 'backend').kind).toBe('backend_failure');
        expect(diagnoseDeliveryError({ code: '08006', message: 'Connection failed' }).kind).toBe('backend_failure');
        expect(shouldPauseCampaignForSendError({ code: 'PGRST202', message: 'Missing database function' })).toBe(true);
        expect(diagnoseDeliveryError(new Error('fetch failed')).kind).toBe('transport_failure');
        expect(diagnoseDeliveryError('Unexplained rejection').kind).toBe('unknown');
        expect(diagnoseDeliveryError('(#551) Cannot complete request').kind).toBe('recipient_unavailable');
        expect(readDeliveryDiagnostic(null, 'error_subcode: 2534001').kind).toBe('conversation_unavailable');
    });

    it('uses the whole audience for outcome percentages and retains unclassified history', () => {
        const metrics = getDeliveryMetrics({ total_recipients: 1000, sent_count: 750, failed_count: 150,
            failure_counts: { recipient_unavailable: 100, backend_failure: 20 } });
        expect([metrics.sentPercent, metrics.failedPercent, metrics.pendingPercent]).toEqual([75, 15, 10]);
        expect(metrics.counts.unknown).toBe(30);
        expect(Object.values(metrics.counts).reduce((sum, value) => sum + value, 0)).toBe(150);
    });

    it('handles empty audiences, missing history, stale aggregates, and cumulative loops', () => {
        expect(getDeliveryMetrics({ total_recipients: 0, sent_count: 0, failed_count: 0 }).sentPercent).toBe(0);
        expect(getDeliveryMetrics({ total_recipients: 5, sent_count: 3, failed_count: 2 }).counts.unknown).toBe(2);
        expect(getDeliveryMetrics({ total_recipients: 5, sent_count: 3, failed_count: 2,
            failure_counts: { recipient_unavailable: 10 } }).counts.recipient_unavailable).toBe(0);
        const loop = getDeliveryMetrics({ total_recipients: 100, sent_count: 150, failed_count: 50, is_loop: true });
        expect([loop.total, loop.sentPercent, loop.failedPercent, loop.pending]).toEqual([200, 75, 25, 0]);
    });
});
